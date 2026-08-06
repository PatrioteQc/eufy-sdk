import { DeviceType } from "../device-types.js";
import { coerceEnumValue, enumLabels } from "../../core/util.js";
import { setPayload } from "./access.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CommandContext } from "./types.js";
import type { Command } from "../../core/contracts.js";

/**
 * The siren's **state-backed param ids** — each is a param the device reports (and some are also
 * writable). Named `SIREN_PARAM` vs `SIREN_CMD` below (momentary triggers with no reported state) so
 * the split the code implements is explicit. Surveyed + write-captured on a real T90R0
 * (`SIREN_SENSOR_E20`, 2026-08-03).
 */
export const SIREN_PARAM = {
  /** Whether the siren is sounding (app `APP_CMD_DEV_RING_STATUS`). 1 = sounding, 0 = silent. */
  RING_STATUS: 61008,
  /** Alarm volume as a device level (app `APP_CMD_SIREN_SENSOR_SET_ALARM_VOL`). See {@link SirenVolume}. */
  ALARM_VOLUME: 1825,
  /** Seconds an alarm sounds before stopping itself (app `APP_CMD_DEV_ALARM_TIMEOUT`). */
  ALARM_TIMEOUT: 61006,
  /** Do-not-disturb (app `APP_CMD_SENSOR_NOT_DISTURB`). */
  NOT_DISTURB: 1828,
} as const;

/**
 * The siren's **write-only command ids** — momentary triggers with no reported state param, so they
 * are gated on the capability's presence rather than a param readback. Both captured live on a T90R0.
 */
export const SIREN_CMD = {
  /** Sound the siren briefly as a test (app `APP_CMD_SIREN_SENSOR_ALARM_TEST`). */
  ALARM_TEST: 1826,
  /** Manually stop a sounding alarm (app `APP_CMD_SIREN_SENSOR_MANUAL_STOP_ALARM`). */
  MANUAL_STOP: 1871,
} as const;

/**
 * Siren alarm volume — a small device level 1-3 (Low/Mid/High), NOT a percentage. Pass a value to
 * `setVolume`.
 */
export const SirenVolume = { Low: 1, Mid: 2, High: 3 } as const;
/** A siren volume level — the value side of {@link SirenVolume}. */
export type SirenVolumeValue = (typeof SirenVolume)[keyof typeof SirenVolume];

/**
 * The alarm-duration presets the app offers, in seconds (1/5/10/15 minutes). These are the only
 * values captured, so `setAlarmDuration` accepts exactly these (rejecting others),
 * the same way the arming capability makes its delay presets the parameter type.
 */
export const SirenAlarmDuration = { Min1: 60, Min5: 300, Min10: 600, Min15: 900 } as const;
/** A siren alarm duration in seconds — the value side of {@link SirenAlarmDuration}. */
export type SirenAlarmDurationValue = (typeof SirenAlarmDuration)[keyof typeof SirenAlarmDuration];

/**
 * Bound siren controls — the object returned by `dev.siren()`.
 *
 * Everything is DERIVED from `SIREN_MEMBERS`. Per this codebase's type-level honesty rule a method
 * present here means its wire is verified, and every write is gated on the device reporting a siren param
 * — so each lands optional and a caller checks. There is no separate "sound the alarm" wire: a real alarm
 * is produced by the armed security system (see the `arming` capability), and `test` is the only
 * on-demand way to make it sound.
 */
export type SirenActions = Surface<typeof SIREN_MEMBERS>;

/**
 * The params whose presence proves the device really is a siren.
 *
 * The momentary triggers have no state param of their own, and detection reaches this capability by
 * DeviceType and a name hint — so a camera, or a renamed device, could be handed a wire that was only
 * ever captured on a real siren. Requiring one of these is the evidence that it is one.
 */
const SIREN_EVIDENCE = [SIREN_PARAM.RING_STATUS, SIREN_PARAM.ALARM_VOLUME, SIREN_PARAM.ALARM_TIMEOUT] as const;

/**
 * A siren write: `1350` SET_PAYLOAD on the device channel with `mValue3` 0, the app's captured frame.
 * The `transaction` stamp is part of that frame; the sink injects `account_id`.
 */
function sirenPayload(cmd: number, body: Record<string, number>, ctx: CommandContext): Command {
  return setPayload(cmd, { ...body, transaction: String(Date.now()) }, ctx, 0);
}

/**
 * Every `siren` feature, declared once. Reads: sounding state, volume, duration, do-not-disturb. Writes
 * (all verified live on a T90R0): volume, duration, test, stop.
 *
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const SIREN_MEMBERS = {
  /**
   * Read-only, and deliberately so: there is no "sound the alarm" wire to pair with it. A real alarm is
   * produced by the armed security system (the `arming` capability); `test` and `stop` are the only
   * on-demand triggers here, so this reports what the siren is doing rather than driving it. Published
   * flat as `siren`, since `active` alone is too generic for the device's property namespace.
   */
  active: {
    param: SIREN_PARAM.RING_STATUS,
    property: "siren",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description:
      "Whether the siren is sounding (61008 APP_CMD_DEV_RING_STATUS). ✅ Confirmed boolean: a live " +
      "test on a T90R0 pushed 1 (sounding) then 0 (silent).",
  },
  /**
   * Rejected, not clamped, outside the 1-3 set: the write is fire-and-forget, so an out-of-range level
   * would look like it worked.
   */
  volume: {
    param: SIREN_PARAM.ALARM_VOLUME,
    property: "sirenVolume",
    type: "number",
    kind: "scalar",
    provenance: "verified",
    requires: [SIREN_PARAM.ALARM_VOLUME],
    enumValues: enumLabels(SirenVolume),
    args: [{ name: "level", kind: "scalar", description: "A device level 1-3 (Low/Mid/High), not a percentage." }],
    description:
      "Alarm volume (1825 APP_CMD_SIREN_SENSOR_SET_ALARM_VOL), a device level 1-3 (Low/Mid/High), NOT " +
      "a percentage. Write verified live on a T90R0 (1350 SET_PAYLOAD {volume}).",
    write: (v, ctx) => {
      const level = coerceEnumValue(SirenVolume, v);
      return level === undefined ? undefined : sirenPayload(SIREN_PARAM.ALARM_VOLUME, { volume: level }, ctx);
    },
  },
  /** Only the four captured presets are accepted: no capture supports an arbitrary duration. */
  alarmDuration: {
    param: SIREN_PARAM.ALARM_TIMEOUT,
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "verified",
    requires: [SIREN_PARAM.ALARM_TIMEOUT],
    enumValues: enumLabels(SirenAlarmDuration),
    args: [{ name: "seconds", kind: "seconds", description: "One of the app's presets: 60/300/600/900." }],
    description:
      "How long an alarm sounds before stopping itself (61006 APP_CMD_DEV_ALARM_TIMEOUT), seconds. " +
      "Write verified live on a T90R0 (1350 SET_PAYLOAD {value}); app presets 60/300/600/900.",
    write: (v, ctx) => {
      const seconds = coerceEnumValue(SirenAlarmDuration, v);
      return seconds === undefined ? undefined : sirenPayload(SIREN_PARAM.ALARM_TIMEOUT, { value: seconds }, ctx);
    },
  },
  /**
   * Read-only: `apk` provenance means the id comes from the disassembled app and the only live evidence
   * is a T90R0 reporting 0, which fixes neither the polarity's other value nor a write frame. Typed
   * `bool` on the app's own naming; do not add a setter until a toggle is captured.
   */
  doNotDisturb: {
    param: SIREN_PARAM.NOT_DISTURB,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description: "Do-not-disturb (1828 APP_CMD_SENSOR_NOT_DISTURB). Observed 0 on a T90R0.",
  },

  /** Sound the siren briefly as a test — the only on-demand way to make a siren sound. */
  test: {
    action: (ctx) => sirenPayload(SIREN_CMD.ALARM_TEST, {}, ctx),
    requires: SIREN_EVIDENCE,
    description: "Sound the siren briefly as a test.",
  },
  /** Manually stop a sounding alarm. */
  stop: {
    action: (ctx) => sirenPayload(SIREN_CMD.MANUAL_STOP, {}, ctx),
    requires: SIREN_EVIDENCE,
    description: "Manually stop a sounding alarm.",
  },
} as const satisfies Members;

/**
 * `siren` — manual/alarm siren. Reads: sounding state (`APP_CMD_DEV_RING_STATUS`), volume, duration,
 * do-not-disturb. Writes (verified live on a T90R0): volume, duration, test, stop.
 */
export const SIREN: CapabilityModule = {
  capability: "siren",
  description: "Manual / alarm siren: sounding state, volume, duration, do-not-disturb, plus test/stop triggers.",
  members: SIREN_MEMBERS,
  properties: propertiesOf(SIREN_MEMBERS),
  /**
   * Detection stays on DeviceType, and that is right: it resolved correctly on a real T90R0
   * (deviceType 123 = `SIREN_SENSOR_E20`), so it is not relying on the model-name hint.
   *
   * Do NOT key siren detection on param 1015: the param dictionary confirms 1015 = `easSwitch`
   * (`CMD_EAS_SWITCH`), an anti-theft switch on ordinary cameras (T8114/T8210), which would false-flag
   * every such camera as a siren.
   *
   * Cameras and the HomeBase can also SOUND an alarm — the hub's lives on the `audio` capability as
   * alarm volume/tone — but that is a station command, not this device capability.
   */
  detection: { deviceTypes: [DeviceType.SIREN_SENSOR, DeviceType.SIREN_SENSOR_E20], modelHints: [/siren/i] },
};
