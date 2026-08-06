/**
 * Unified device + transport model.
 *
 * One package, every eufy device class. Two things vary per device and are
 * abstracted here so the rest of the code never branches on device kind:
 *
 *   API backend   — how we talk to the cloud:
 *     - 'mega'     : the v6 Anker AIoT API (algo_ecdh signed bodies). Used for EVERY device —
 *                    appliances/lights/vacuums AND cameras/HomeBases/sensors (device list, dsk,
 *                    ciphers, faces, events). This is the only backend the SDK uses.
 *     - 'legacy'   : the classic pre-v6 eufy security API. NOT used by this
 *                    SDK (v6 migrated everything to mega); kept for reference/old apps.
 *
 *   Realtime transport — how live state/commands flow:
 *     - 'smqtt'    : secure Anker MQTT broker (mTLS, aiot-mqtt-*.anker.com:8883).
 *     - 'p2p'      : peer-to-peer ThroughTek PPCS (LAN-direct/relay) — cameras. (eufy's own leo_rtc
 *                    WebRTC is a separate stack used only by newer NVR-class devices.)
 *
 * A device declares which it uses; the facade routes accordingly.
 */

/**
 * Names the wire backends a device is reachable on — transport vocabulary, not a host concern.
 * @internal
 */
export type ApiBackend = "mega" | "legacy";
export type RealtimeKind = "smqtt" | "p2p";
/**
 * The coarse grouping a host buckets devices by. Every value is one the SDK can actually DERIVE from a
 * resolved codec — anything the codec space doesn't confidently name lands in `"other"` rather than a
 * guess. Intentionally coarse: a host needing the precise kind reads the capabilities.
 */
export type DeviceClass = "camera" | "homebase" | "vacuum" | "mower" | "sensor" | "light" | "other";

/** Normalised device record, regardless of which API produced it. */
export interface EufyDevice {
  sn: string;
  name?: string;
  model: string;
  /** Anker category string: eufy_security | eufy_mega | eufy_home … */
  category: string;
  deviceClass: DeviceClass;
  /** Which cloud API owns this device. */
  api: ApiBackend;
  /** Which realtime transport carries its live state/commands. */
  realtime: RealtimeKind;
  stationSn?: string;
  /** Present (and non-empty) for P2P devices. */
  p2pDid?: string;
  /**
   * Device state data points (param_type → param_value), exactly as the cloud record carries them.
   * Raw and unnamed: a host reads state through the capability surface, which resolves these into
   * named properties. `Device.inspect` labels them for troubleshooting.
   *
   * **Not a realtime source.** These are refreshed server-side on the device's own cloud heartbeat,
   * which is slow: measured across a live fleet, the freshest param on an active device was ~12 minutes
   * old, and the per-device `get_device_param_list` call returns the same staleness as the bulk list
   * (so fetching harder does not make them fresher). Treat them as a coarse state snapshot + liveness
   * evidence ({@link paramUpdatedAt}); realtime state arrives over push / P2P / MQTT.
   */
  params?: Record<number, string>;
  /**
   * When each param in {@link params} was last written server-side (`param_type` → **unix SECONDS**,
   * the wire's own `update_time` unit — not milliseconds). The device heartbeats its params up to the
   * cloud, so these are the freshest liveness evidence available without opening a transport.
   *
   * Sparse by construction: a param the record delivered without an `update_time` has no entry here.
   */
  paramUpdatedAt?: Record<number, number>;
  /**
   * The most recent {@link paramUpdatedAt} across all of this device's params, in **milliseconds**
   * (comparable to `Date.now()` directly). `undefined` when the record carried no timestamp at all.
   *
   * This is an observation — "the device last reported at T" — deliberately **not** a reachability
   * verdict. How long a silence means "unreachable" depends on the device (a mains camera heartbeats
   * constantly; a battery sensor may be quiet for days by design), so the threshold is the caller's to
   * choose; the SDK reports the fact.
   */
  lastSeenMs?: number;
  /** Raw record from the source API, for fields not yet normalised. */
  raw?: unknown;
}

/** A realtime message normalised across transports. */
export interface RealtimeMessage {
  deviceSn?: string;
  topic?: string;
  raw: unknown;
}

/**
 * Common surface for every realtime transport (smqtt / p2p).
 * Implementations live under src/mqtt and src/p2p; the facade owns selection.
 */
export interface RealtimeTransport {
  readonly kind: RealtimeKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribeDevice(device: EufyDevice): Promise<void>;
  /** Publish a command body to a device topic (the `/req` direction). */
  publish(topic: string, body: string | Buffer, opts?: { qos?: 0 | 1 | 2 }): Promise<void>;
  on(event: "connect", listener: () => void): this;
  on(event: "disconnect", listener: (reason?: unknown) => void): this;
  on(event: "message", listener: (msg: RealtimeMessage) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

/**
 * Map a device's category to its API backend + realtime transport.
 *
 * Deliberately does NOT classify the device itself. Which *kind* of thing a record is depends on the
 * eufy `DeviceType` space, which grows with every product launch — that knowledge lives in `model/`
 * (`codecForType`, where camera is the residual bucket so a new SKU needs no edit), and duplicating a
 * list of ids here would mean editing the leaf layer on every release. The client derives
 * {@link EufyDevice.deviceClass} from the resolved codec instead.
 *
 * The security ecosystem (cameras / HomeBases / sensors) is `p2p`: v6 serves its cloud side through
 * the SAME mega (`algo_ecdh`) API as everything else — device list, dsk, ciphers, faces, events — but
 * its realtime is P2P plus push, never MQTT. A `p2p_did` alone is sufficient evidence, since only that
 * ecosystem is issued one. Everything else is a mega/home appliance on Anker secure MQTT.
 *
 * Internal classification helper; `Device` carries the resolved result.
 * @internal
 */
export function classifyDevice(
  raw: { category?: string; device_model?: string; p2p_did?: string; device_type?: number } & Record<string, unknown>,
): Pick<EufyDevice, "api" | "realtime" | "category"> {
  const category = raw.category ?? "";
  const hasP2p = typeof raw.p2p_did === "string" && raw.p2p_did.length > 0;
  if (category === "eufy_security" || hasP2p) return { category, api: "mega", realtime: "p2p" };
  return { category, api: "mega", realtime: "smqtt" };
}
