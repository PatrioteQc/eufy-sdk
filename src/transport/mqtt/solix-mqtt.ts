/**
 * Live telemetry for Anker Solix devices over the AWS-IoT MQTT plane.
 *
 * The transport is the shared `SecureMqtt` — the exact same anker AWS-IoT broker + per-user
 * client-cert mutual TLS the eufy device path uses; a Solix account's `get_user_mqtt_info` result maps
 * straight onto {@link SecureMqttCredentials}. Solix devices publish telemetry continuously on
 * `dt/{app_name}/{product_code}/{device_sn}/param_info` as an **ff09 TLV frame** (the same framing
 * family as {@link parseFf09SettingsResponse}), so this module only adds the Solix topic + a small
 * ff09 param decoder on top of the reused transport.
 *
 * Frame layout (observed on a Smart Meter Gen 2 / AE1X0):
 *   ff09 | len(u16 LE, incl. trailing XOR checksum) | 5-byte header | TLV fields | xor
 * each TLV field is `tag(1) | len(1) | value(len)`; measurement fields carry `type(1) | 4 bytes`,
 * type `0x05` = float32 LE. Field `a2` is the device serial (ASCII after a leading type byte).
 */
import { EventEmitter } from "node:events";

import { SecureMqtt, type SecureMqttCredentials } from "./secure-mqtt.js";
import { walkFf09Tlv } from "../ff09.js";
import { buildAppShapedClientId, deriveMqttUuid } from "./app-client-id.js";
import { solixDeviceTopics, solixUserTopics } from "./topics.js";
import { genId, type Logger } from "../../core/index.js";

/** A decoded telemetry channel: the raw value plus float/uint interpretations of a 4-byte payload. */
export interface SolixChannel {
  /** The leading type byte (`0x05` = float32 LE for the meter's measurement channels). */
  type: number;
  raw: Buffer;
  /** Present when the payload is 4 bytes: little-endian float32. */
  float?: number;
  /** Present when the payload is 4 bytes: little-endian uint32. */
  uint?: number;
}

/** A parsed ff09 param frame: the device serial (from `a2`) + the raw TLV field map keyed by tag. */
export interface SolixParamFrame {
  deviceSn?: string;
  /** tag byte → value bytes (still including the per-field leading type byte for measurement fields). */
  fields: Map<number, Buffer>;
}

/**
 * Telemetry field tags for the Smart Meter (AE1X0), keyed by ff09 tag byte. Names are the app's own
 * (recovered from the Anker app's compiled-Dart strings in `libapp.so` — module
 * `package:third_device/src/module/ae1x0/…`): the meter is 3-phase-capable and reports each quantity
 * per line (L1/L2/L3) plus an aggregate total.
 *
 * Confidence:
 * - `0xac` = `meterVoltageL1` is CONFIRMED against live single-phase data (a nominal mains voltage).
 * - The rest are a STRUCTURAL INFERENCE from a quantity-major-by-phase layout that is consistent with
 *   every observation to date: on a single-phase / single-CT install only the L1 and total slots move
 *   (a8==ab because PowerL1==PowerTotal), the L2/L3 slots read 0, and the load-responsive tags
 *   (a8/ab/af/b3) line up with PowerL1/PowerTotal/CurrentL1/ImportEnergy. Bind them hard with one
 *   known-load capture and adjust here if a magnitude disagrees.
 * - Tags 0xb5–0xb7 are left unnamed (surface as `channel_b5`..`channel_b7`). The app's Dart decoder
 *   names NO field beyond the 14 above (no frequency / power-factor / reactive / temperature field
 *   exists in libapp.so), so these are reserved/unused in the app. `b7` sits at ~0.1 at idle — a
 *   firmware-level power-factor candidate (would climb toward ~1.0 under a resistive load); unconfirmed.
 *
 * Unnamed measurement tags always still surface as `channel_<tag>`, so nothing is lost.
 */
export const SOLIX_METER_FIELD_NAMES: Readonly<Record<number, string>> = {
  0xa8: "meterPowerL1",
  0xa9: "meterPowerL2",
  0xaa: "meterPowerL3",
  0xab: "meterPowerTotal",
  0xac: "meterVoltageL1", // CONFIRMED live
  0xad: "meterVoltageL2",
  0xae: "meterVoltageL3",
  0xaf: "meterCurrentL1",
  0xb0: "meterCurrentL2",
  0xb1: "meterCurrentL3",
  0xb2: "meterCurrentTotal",
  0xb3: "meterImportEnergy",
  0xb4: "meterExportEnergy",
};

/** Interpret one TLV value as a telemetry channel (leading type byte + payload). */
export function readSolixChannel(value: Buffer | undefined): SolixChannel | undefined {
  if (!value || value.length < 1) return undefined;
  const raw = value.subarray(1);
  const ch: SolixChannel = { type: value[0]!, raw };
  if (raw.length === 4) {
    ch.float = raw.readFloatLE(0);
    ch.uint = raw.readUInt32LE(0);
  }
  return ch;
}

/**
 * Decode an ff09 Solix param frame into its serial + TLV field map. Returns `null` for a non-ff09
 * buffer, a length field that doesn't fit, or a bad checksum. Validates the trailing XOR checksum first
 * (so a corrupted frame is rejected rather than yielding plausible floats), then walks `tag|len|value`
 * from the first `0xa1` tag to the declared length minus the checksum byte via the shared
 * `walkFf09Tlv` (bounded by `end`, so a field length can't overrun into the checksum).
 */
export function decodeSolixParamFrame(buf: Buffer): SolixParamFrame | null {
  if (buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0x09) return null;
  const declaredLen = buf.readUInt16LE(2);
  if (declaredLen < 5 || declaredLen > buf.length) return null; // length field must fit the buffer
  // Trailing byte is the XOR of every preceding byte, so XOR over the whole declared frame is 0.
  let xor = 0;
  for (let i = 0; i < declaredLen; i++) xor ^= buf[i]!;
  if (xor !== 0) return null;
  const end = declaredLen - 1; // exclusive of the trailing XOR checksum byte
  const start = buf.indexOf(0xa1, 4);
  if (start < 0 || start >= end) return { fields: new Map() };
  const fields = walkFf09Tlv(buf, start, end);
  let deviceSn: string | undefined;
  const a2 = fields.get(0xa2);
  if (a2 && a2.length > 1) deviceSn = a2.subarray(1).toString("latin1").replace(/\0+$/, "") || undefined;
  return { deviceSn, fields };
}

/**
 * Reduce a param frame to named + raw telemetry values. Measurement channels (`0xa6`..`0xff`) are
 * decoded as float32 where the payload is 4 bytes; a tag in {@link SOLIX_METER_FIELD_NAMES} is emitted
 * under its name (e.g. `meterVoltageL1`), and all measurement tags additionally under `channel_<hex tag>`.
 */
export function solixReadings(frame: SolixParamFrame): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [tag, value] of frame.fields) {
    if (tag < 0xa6) continue; // a1/a2/a3 are count/serial/status, not measurements
    const ch = readSolixChannel(value);
    // 0x05 = float32 measurement channel (confirmed live); other types are non-measurement params.
    if (ch?.type !== 0x05 || ch.float === undefined) continue;
    out[`channel_${tag.toString(16)}`] = ch.float;
    const name = SOLIX_METER_FIELD_NAMES[tag];
    if (name) out[name] = ch.float;
  }
  return out;
}

/** A live telemetry sample emitted by {@link SolixMqtt} as a `reading` event. */
export interface SolixReading {
  deviceSn: string;
  productCode: string;
  topic: string;
  frame: SolixParamFrame;
  values: Record<string, number>;
}

/** The minimum device shape {@link SolixMqtt.watch} needs (as returned by `SolixClient.getDevices`). */
export interface SolixMqttDevice {
  device_sn: string;
  product_code: string;
}

/** Options for {@link SolixMqtt}. */
export interface SolixMqttOptions {
  /** `get_user_mqtt_info` result — carries endpoint, cert/key, app_name, thing_name, user_id. */
  mqttInfo: SecureMqttCredentials;
  /** Override the MQTT clientId. Defaults to the cert CN (`thing_name`), distinct from the app's id. */
  clientId?: string;
  /**
   * Account/user id (40-hex) for the arming `account_id` + heartbeat topic. Defaults to
   * `mqttInfo.user_id`; set it if the credentials omit it.
   */
  userId?: string;
  /**
   * How often (ms) to re-send the device-info arming request that keeps realtime telemetry flowing.
   * The device stops pushing `param_info` when no client keeps requesting it (the app re-arms on every
   * foreground resume + a periodic heartbeat), so a passive subscriber goes silent after the server's
   * reporting window closes. Default 25s — inside the observed ~30s cadence with keepalive 60. Set `0`
   * to disable arming (subscribe-only, the old behaviour).
   */
  armIntervalMs?: number;
  /**
   * The `head.client_id` stamped into the command/heartbeat envelopes — the app-shaped
   * `android-{app_name}-{user_id}-{mqttUuid}-{ts}` (see {@link buildAppShapedClientId}). Defaults to
   * that shape built from {@link mqttUuid}. Pass this to pin the whole string.
   */
  appClientId?: string;
  /**
   * Stable 16-hex install UUID for the app-shaped client id. Defaults to one derived deterministically
   * from the user id ({@link deriveMqttUuid}) — the same no-storage trick `SolixClient` uses for
   * `openudid`, so the broker sees one stable client across restarts without any persistence. Pass this
   * to pin an explicit value.
   */
  mqttUuid?: string;
  /** The account's `site_id` for the `power_site` heartbeat. Omitted from the frame when unknown. */
  siteId?: string;
  logger?: Logger;
}

/**
 * Subscribe to a Solix device's live telemetry and emit decoded `reading` events. Reuses
 * `SecureMqtt` for the connection; adds only the Solix data topic + ff09 param decoding.
 *
 *   const mqtt = new SolixMqtt({ mqttInfo: await solix.getUserMqttInfo() });
 *   mqtt.on("reading", (r) => console.log(r.deviceSn, r.values.meterVoltageL1));
 *   await mqtt.watch(device);   // device = a SolixClient.getDevices() entry
 */
export class SolixMqtt extends EventEmitter {
  private readonly transport: SecureMqtt;
  private readonly appName: string;
  private readonly userId?: string;
  private readonly appClientId: string;
  private readonly armIntervalMs: number;
  private readonly logger?: Logger;
  private readonly siteId?: string;
  private readonly watched = new Map<string, SolixMqttDevice>();
  private seq = 0;
  private armTimer?: ReturnType<typeof setInterval>;

  constructor(opts: SolixMqttOptions) {
    super();
    this.appName = opts.mqttInfo.app_name ?? "anker_power";
    this.userId = opts.userId ?? opts.mqttInfo.user_id;
    this.armIntervalMs = opts.armIntervalMs ?? 25_000;
    this.siteId = opts.siteId;
    this.logger = opts.logger;
    // The app's client_id shape (android-{app}-{uid}-{mqttUuid}-{ts}); the mqttUuid must be stable
    // across restarts or every restart looks like a new broker client. Default it deterministically
    // from the user id (no storage needed) rather than a fresh random per instance.
    const uid = this.userId ?? "anonymous";
    this.appClientId =
      opts.appClientId ??
      buildAppShapedClientId({
        appName: this.appName,
        uid,
        mqttUuid: opts.mqttUuid ?? deriveMqttUuid(`anker-solix-mqtt:${uid}`),
      });
    this.transport = new SecureMqtt({
      credentials: opts.mqttInfo,
      clientId: opts.clientId ?? opts.mqttInfo.thing_name,
      reconnectPeriod: 5000,
      logger: opts.logger,
    });
    this.transport.on("error", (e) => this.emit("error", e));
    this.transport.on("message", (msg: { topic?: string; raw: unknown }) => this.onMessage(msg));
  }

  /**
   * Connect, subscribe to the device's telemetry (+ command-reply) topics, ARM realtime reporting, and
   * start the re-arm/heartbeat timer so telemetry keeps flowing without the app. Idempotent per device.
   */
  async watch(device: SolixMqttDevice): Promise<void> {
    await this.transport.connect();
    const topics = solixDeviceTopics(this.appName, device.product_code, device.device_sn);
    // SUBSCRIBE only to what the device SENDS: its telemetry (param_info) + command replies, plus the
    // account reply channel. NOT the device/account `…/req` channels — those are the app→device request
    // side that we PUBLISH to when arming (subscribing there would echo our own requests back).
    const granted = await this.transport.subscribe([
      topics.paramInfo, // ff09 telemetry frames (the only thing we decode)
      topics.cmdRes, // this device's command replies
      ...(this.userId ? [solixUserTopics(this.appName, this.userId).cmdRes] : []),
    ]);
    // A scope-denied filter comes back as SUBACK_FAILURE, not an error (AWS IoT quirk — see
    // SecureMqtt.subscribe), so an unusable subscription otherwise looks like success: watch() would
    // resolve, arming would publish every armIntervalMs, and no telemetry would ever arrive. paramInfo
    // is the one topic whose denial makes the whole call pointless, so fail loudly if it wasn't granted.
    if (!granted.includes(topics.paramInfo)) {
      const scope = this.appName;
      throw new Error(
        `watch ${device.device_sn}: telemetry topic "${topics.paramInfo}" denied on credential scope ` +
          `"${scope}" — the subscription would arm but never deliver a reading`,
      );
    }
    this.watched.set(device.device_sn, device);
    if (this.armIntervalMs > 0) {
      await this.armAll();
      if (!this.armTimer) {
        this.armTimer = setInterval(() => void this.armAll(), this.armIntervalMs);
        // Don't hold the event loop open: a caller that watches and returns can still exit.
        this.armTimer.unref?.();
      }
    }
  }

  /** Tear down the connection and stop the re-arm timer. */
  async close(): Promise<void> {
    if (this.armTimer) {
      clearInterval(this.armTimer);
      this.armTimer = undefined;
    }
    this.watched.clear();
    await this.transport.disconnect();
  }

  /**
   * Re-arm every watched device and send the site heartbeat. The device only pushes `param_info` while
   * a client keeps requesting it — this replays the app's `requestDeviceInfo` (cmd 17) + `power_site`
   * heartbeat (cmd 10), the exact envelopes captured live (see docs). Best-effort: a publish failure is
   * emitted, not thrown, so one bad device doesn't stop the rest or kill the timer.
   */
  private async armAll(): Promise<void> {
    for (const device of this.watched.values()) {
      try {
        await this.arm(device);
      } catch (e) {
        this.emit("error", e);
      }
    }
    if (this.userId) {
      try {
        await this.transport.publish(solixUserTopics(this.appName, this.userId).powerSite, this.heartbeatEnvelope(), {
          qos: 1,
        });
      } catch (e) {
        this.emit("error", e);
      }
    }
  }

  /** Publish the device-info arming request (both the "info" and "realtime" ff09 variants the app sends). */
  private async arm(device: SolixMqttDevice): Promise<void> {
    const topic = solixDeviceTopics(this.appName, device.product_code, device.device_sn).req;
    for (const variant of ["info", "realtime"] as const) {
      const body = this.commandEnvelope(
        device,
        buildFf09Request(variant),
        variant === "info" ? { encoding_type: 2 } : {},
      );
      await this.transport.publish(topic, body, { qos: 1 });
    }
    this.logger?.debug?.(`[solix] armed ${device.device_sn} (param_info reporting requested)`);
  }

  /** The common `head` fields for every cmd envelope; callers add `cmd` + the per-message variable bits. */
  private makeHead(cmd: number, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      version: "1.0.0.1",
      client_id: this.appClientId,
      timestamp: Math.floor(Date.now() / 1000),
      cmd_status: 2,
      sign_code: 1,
      cmd,
      ...extra,
    };
  }

  /** Build the `{head, payload}` cmd-17 (requestDeviceInfo) envelope carrying a base64 ff09 request. */
  private commandEnvelope(device: SolixMqttDevice, frame: Buffer, extra: Record<string, unknown>): string {
    this.seq += 1;
    return JSON.stringify({
      head: this.makeHead(17, {
        sess_id: genId(),
        msg_seq: this.seq,
        seed: genId(),
        device_pn: device.product_code,
        device_sn: device.device_sn,
      }),
      payload: JSON.stringify({
        device_sn: device.device_sn,
        account_id: this.userId ?? "",
        data: frame.toString("base64"),
        ...extra,
      }),
    });
  }

  /** The `power_site` heartbeat (cmd 10) envelope the app sends on a timer to keep the session alive. */
  private heartbeatEnvelope(): string {
    return JSON.stringify({
      head: this.makeHead(10, { sess_id: "1", msg_seq: 1, seed: "1" }),
      // Only include site_id when known — an empty placeholder to a live broker can't be told from a
      // real one (fire-and-forget), so omit it rather than send "".
      payload: JSON.stringify({ user_id: this.userId ?? "", ...(this.siteId ? { site_id: this.siteId } : {}) }),
    });
  }

  /** Decode one inbound MQTT message envelope and emit a `reading` if it carries an ff09 param frame. */
  private onMessage(msg: { topic?: string; raw: unknown }): void {
    const topic = msg.topic ?? "";
    const buf = extractFf09Payload(msg.raw);
    if (!buf) return;
    const frame = decodeSolixParamFrame(buf);
    if (!frame) return;
    const parts = topic.split("/"); // dt/{app}/{pn}/{sn}/param_info
    const reading: SolixReading = {
      deviceSn: frame.deviceSn ?? parts[3] ?? "",
      productCode: parts[2] ?? "",
      topic,
      frame,
      values: solixReadings(frame),
    };
    this.emit("reading", reading);
  }
}

/**
 * Pull the ff09 binary frame out of a received message. Solix telemetry arrives as a `{head, payload}`
 * envelope whose `payload` is a JSON string carrying base64 `data` (or `trans`); `SecureMqtt`
 * has already JSON-parsed the outer envelope. Returns the decoded frame bytes, or `null`.
 */
export function extractFf09Payload(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (!raw || typeof raw !== "object") return null;
  const env = raw as { payload?: unknown; data?: unknown };
  let payload: unknown = env.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  const data = (payload as { data?: unknown; trans?: unknown } | undefined)?.data ?? env.data;
  if (typeof data !== "string") return null;
  const buf = Buffer.from(data, "base64");
  return buf.length ? buf : null;
}

/**
 * Build the ff09 request frame the app base64-encodes into a `requestDeviceInfo` (cmd 17) command's
 * `data`. Captured live from the Anker app — request-type tag `a1`=0x22; the `realtime` variant adds
 * `a2`/`a3` params (this is the one that keeps `param_info` reporting flowing), while `info` is the bare
 * device-info fetch. Frame:
 *   `ff09 | len(u16 LE, TOTAL bytes incl. ff09+len+xor) | 5-byte header | a1 01 22
 *    [| a2 02 01 01 | a3 03 02 2c 01] | fe … <ts32 LE> | xor`
 * `fe` carries a fresh unix-timestamp nonce; the trailing byte is XOR of every preceding byte (the same
 * checksum the meter's telemetry frames use — verified to reproduce the captured frames exactly).
 */
export function buildFf09Request(variant: "info" | "realtime", atUnixSec?: number): Buffer {
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE((atUnixSec ?? Math.floor(Date.now() / 1000)) >>> 0);
  const body =
    variant === "info"
      ? Buffer.concat([Buffer.from([0x03, 0x00, 0x0f, 0x00, 0x40, 0xa1, 0x01, 0x22, 0xfe, 0x04]), ts])
      : Buffer.concat([
          Buffer.from([
            0x03, 0x00, 0x0f, 0x00, 0x57, 0xa1, 0x01, 0x22, 0xa2, 0x02, 0x01, 0x01, 0xa3, 0x03, 0x02, 0x2c, 0x01, 0xfe,
            0x05, 0x03,
          ]),
          ts,
        ]);
  const frame = Buffer.alloc(body.length + 5);
  frame[0] = 0xff;
  frame[1] = 0x09;
  frame.writeUInt16LE(frame.length, 2); // declared length = total frame bytes (incl. ff09, len, xor)
  body.copy(frame, 4);
  let xor = 0;
  for (let i = 0; i < frame.length - 1; i++) xor ^= frame[i]!;
  frame[frame.length - 1] = xor;
  return frame;
}
