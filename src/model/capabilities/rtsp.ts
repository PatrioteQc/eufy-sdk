import type { Command } from "../../core/contracts.js";
import { asBool, enumLabels } from "../../core/util.js";
import { setJson, setPayload, setScalar } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CommandContext } from "./types.js";

/** The state params this capability owns — its OWN vocabulary, used by no other capability. */
export const RTSP_PARAM = {
  /**
   * RTSP publish switch (app `NAS_STREAM_SWITHC`, the vendor's own typo for SWITCH). `1` publishes the
   * camera's stream, `0` withdraws it. ✅ Verified live 2026-08-01 on a HomeBase-attached doorbell and
   * two indoor cameras: written through this param's scalar wire, both directions confirmed by the
   * stream appearing and disappearing on the serving device's RTSP port.
   */
  STREAM_SWITCH: 1145,
  /**
   * RTSP credentials + the authentication switch (app `NAS_SEND_SECURITY_PASSWD`). A `SET_PAYLOAD`
   * (1350) envelope: `{cmd:1287, mChannel:<deviceCh>, mValue3:0, payload:{mode, passwd, username}}`.
   *
   * ✅ Byte-exact against the app's own frame (confirmed 2026-08-03 on a
   * T8425 behind a T8030): the app auto-generates BOTH a username and a password (16 chars each — its
   * "13 char" UI rule is frontend-only; the firmware accepts any length). The `mode` field is the
   * auth scheme, all three confirmed live (frame + served `WWW-Authenticate` header):
   * `0` = open, `1` = Basic, `2` = Digest. The app offers Basic/Digest but no "open" option. The
   * credentials also come back embedded in the URL the device echoes when publishing — see
   * `requireAuth`.
   */
  SEND_SECURITY_PASSWD: 1287,
  /**
   * What the NAS records (app `NAS_VIDEO_TYPE_EVENT`): events only or continuously. The readable half
   * of the app's two-frame recording-mode pair (6050 + 6010). ✅ Write verified live on a T8030 by
   * param readback (0 → 1 → 0).
   */
  VIDEO_TYPE_EVENT: 6050,
  /** Second frame of the recording-mode pair — see {@link VIDEO_TYPE_EVENT}. Sent with it, never alone. */
  VIDEO_TYPE_CONTINUE: 6010,
} as const;

/**
 * The RTSP authentication scheme a caller can require. Maps to the credential write's `mode` field.
 *
 * - `"digest"` — the server answers a describe with a hashed nonce challenge; the password never
 *   crosses the wire. The safer choice, and the app's default.
 * - `"basic"` — the reader sends the password base64-encoded on every request (encoding, not
 *   encryption — readable by anyone sniffing the LAN). Offered for players that only speak Basic.
 */
export type RtspAuthScheme = "digest" | "basic";

/**
 * `mode` on the credential write — the authentication switch. ✅ All three verified live: `0` serves
 * openly, `1` answers a Basic challenge, `2` answers a Digest challenge. The app sends `2` (Digest) by
 * default and exposes Basic/Digest in its UI but no "open" option.
 */
const AUTH_MODE = { off: 0, basic: 1, digest: 2 } as const;

/**
 * What the NAS records. `Events` stores clips around a detection; `Continuous` records without
 * stopping.
 */
export const RtspRecordingMode = {
  /** Record only around detections. */
  Events: 0,
  /** Record continuously. */
  Continuous: 1,
} as const;
/** A NAS recording mode — the value side of {@link RtspRecordingMode}. */
export type RtspRecordingModeValue = (typeof RtspRecordingMode)[keyof typeof RtspRecordingMode];

/**
 * Bound RTSP controls — the object returned by `dev.rtsp()`.
 *
 * This is the vendor's NAS/RTSP feature: publish a camera's stream so a NAS/NVR (or the HomeBase
 * itself) can record it. Two things a caller must know, because neither is expressible in the wire:
 *
 * - **A station publishes for ONE attached camera at a time.** Enabling a second withdraws the first,
 *   silently — the station tracks a single camera, not a set. The SDK cannot detect or prevent this;
 *   a caller driving several cameras owns the arbitration.
 * - **A published stream encodes continuously**, with none of the budget the live-media path applies.
 *   On a device with the `battery` capability that will drain the cell, so the feature suits mains
 *   -powered cameras feeding a recorder.
 *
 * The stream itself is served over plain RTSP on the local network, by the station for a
 * HomeBase-attached camera or by the camera itself when standalone. Authentication is honoured in
 * BOTH cases — the station enforces the credential setting on an attached camera's stream, and a
 * standalone camera on its own. The effect is observable with an RTSP `DESCRIBE`: 401 = challenged,
 * 200 = open.
 */
export type RtspActions = Surface<typeof RTSP_MEMBERS>;

/** The RTSP publish switch, both directions — a plain scalar, verified live on both topologies. */
function publishCommand(on: boolean, ctx: CommandContext): Command {
  return setScalar(RTSP_PARAM.STREAM_SWITCH, on ? 1 : 0, ctx);
}

/**
 * The credentials frame. `mValue3` is 0, byte-exact with the app's own frame (captured live 2026-08-03
 * on a T8425 behind a T8030): `{cmd:1287, mChannel:<deviceCh>, mValue3:0, payload:{mode,passwd,username}}`.
 * Passing 0 explicitly overrides the transport's `mValue3 ?? cmd` default, which would send 1287.
 */
function credentialsCommand(mode: number, username: string, password: string, ctx: CommandContext): Command {
  return setPayload(RTSP_PARAM.SEND_SECURITY_PASSWD, { mode, username, passwd: password }, ctx, 0, undefined, "auto");
}

/**
 * Every `rtsp` feature, declared once.
 *
 * `setRecordingMode` is a `method`, not a derived setter, because ONE UI change is TWO frames on
 * the wire — the app sends 6050 then 6010, and sending only the first leaves the continuous recorder out
 * of step with the advertised type. A member's `write` returns a single command, so the pair cannot be
 * expressed as one.
 *
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const RTSP_MEMBERS = {
  /**
   * `provenance` is name-trust: the name is the app's own typo'd constant (`NAS_STREAM_SWITHC`), so it
   * is "apk". The verified live WRITE — both directions, HomeBase and standalone — is in the description.
   */
  published: {
    param: RTSP_PARAM.STREAM_SWITCH,
    property: "rtspStream",
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description:
      "Whether this camera's stream is published over RTSP (1145 NAS_STREAM_SWITHC). Name from the " +
      "apk; the WRITE is verified live on a HomeBase-attached doorbell and two indoor cameras, both " +
      "directions (DESCRIBE 404→200 with a real SDP, and back).",
    write: (v, ctx) => publishCommand(asBool(v), ctx),
    aliases: { publish: true, withdraw: false },
  },
  /**
   * The READ half of a control written by `setRecordingMode` below, hence `writtenElsewhere` — one UI
   * change is TWO frames on the wire (6050 then 6010) and a member's `write` returns a single command,
   * so the pair cannot be a derived setter. 6050 is the half the device reports back, which is why the
   * member hangs off that id and not its silent partner.
   */
  recordingMode: {
    param: RTSP_PARAM.VIDEO_TYPE_EVENT,
    type: "enum",
    kind: "enum",
    enumValues: enumLabels(RtspRecordingMode),
    provenance: "apk",
    writtenElsewhere: true,
    description:
      "What the NAS records: 0 = events only, 1 = continuous (6050 NAS_VIDEO_TYPE_EVENT). The app " +
      "sends a PAIR of 1700-wrapped frames (6050 + 6010) for one change; setRecordingMode sends both. " +
      "6050 is the readable half. Name from the apk; the WRITE is verified live on a T8030 by param " +
      "readback (0 → 1 → 0).",
  },

  /** Publish this camera's stream. Withdraws whichever camera the station was publishing before. */
  publish: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        sink.dispatch(publishCommand(true, ctx)),
    "Publish the stream.",
  ),
  /** Withdraw this camera's stream. */
  withdraw: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        sink.dispatch(publishCommand(false, ctx)),
    "Withdraw the stream.",
  ),

  /**
   * Require authentication on this camera's stream, with the given credentials. A reader that does not
   * present them is then refused (`DESCRIBE` answers 401 instead of 200).
   *
   * `scheme` defaults to `"digest"` (a hashed nonce challenge — the password never crosses the wire,
   * and the app's own default). Pass `"basic"` only for a player that can't do Digest: Basic sends the
   * password base64-encoded on every request, readable by anyone on the LAN.
   *
   * Works on both topologies — a HomeBase-attached camera (the station enforces the setting on the
   * stream it serves) and a standalone one. There is no read-back for credentials, so verify the effect
   * with a `DESCRIBE` (401 = challenged) rather than assuming the write landed. The device also echoes
   * its own RTSP URL — with the credentials embedded — on the publish param.
   */
  requireAuth: method(
    ({ ctx, sink }) =>
      (username: string, password: string, scheme: RtspAuthScheme = "digest"): Promise<void> =>
        sink.dispatch(
          credentialsCommand(scheme === "basic" ? AUTH_MODE.basic : AUTH_MODE.digest, username, password, ctx),
        ),
    "Require authentication on the stream.",
  ),
  /** Serve this camera's stream without authentication, keeping the stored credentials. */
  allowAnonymous: method(
    ({ ctx, sink }) =>
      (username: string, password: string): Promise<void> =>
        sink.dispatch(credentialsCommand(AUTH_MODE.off, username, password, ctx)),
    "Serve the stream without authentication.",
  ),

  /**
   * Set what the NAS records — events only, or continuously. Sends the app's two-frame pair in one call.
   * Present only when this camera reports the recording-mode state, mirroring the publish switch's own
   * evidence gate.
   *
   * On a battery-powered camera, `Continuous` keeps the stream up and will flatten the battery far
   * faster than event recording — the app only offers it for wired/HomeBase-attached cameras.
   */
  setRecordingMode: method(
    ({ ctx, sink }) =>
      async (mode: RtspRecordingModeValue | number): Promise<void> => {
        const v = Number(mode);
        if (v !== RtspRecordingMode.Events && v !== RtspRecordingMode.Continuous) {
          throw new Error(`rtsp: recordingMode ${JSON.stringify(mode)} must be 0 (events) or 1 (continuous)`);
        }
        await sink.dispatch(setJson(RTSP_PARAM.VIDEO_TYPE_EVENT, { value: v }, ctx));
        await sink.dispatch(
          setJson(
            RTSP_PARAM.VIDEO_TYPE_CONTINUE,
            {
              enable: v,
              index: 0,
              status: 0,
              type: 0,
              value: 0,
              voiceID: 0,
              zonecount: 0,
              transaction: Math.floor(Math.random() * 1e7) + 1,
            },
            ctx,
          ),
        );
      },
    "Set what the NAS records: events only, or continuously.",
    (ctx) => ctx.paramIds.has(RTSP_PARAM.VIDEO_TYPE_EVENT),
  ),
} as const satisfies Members;

/**
 * `rtsp` — publish a camera's stream over RTSP for a NAS/NVR to record.
 *
 * Detection is evidence-only: a device advertises param 1145 or it does not get the accessor. The
 * vendor app gates the setting to a subset of models, but that gate is CLIENT-side — a model whose app
 * never shows the toggle still accepts the write, which is why detection keys off the reported param
 * rather than a model table.
 */
export const RTSP: CapabilityModule = {
  capability: "rtsp",
  description:
    "Publish a camera's stream over RTSP on the local network for a NAS/NVR to record. One camera " +
    "at a time per station; a published stream encodes continuously.",
  members: RTSP_MEMBERS,
  properties: propertiesOf(RTSP_MEMBERS),
  detection: { evidenceParams: [RTSP_PARAM.STREAM_SWITCH] },
};
