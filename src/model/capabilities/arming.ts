import { enumLabels } from "../../core/util.js";
import { describeDevice, setJsonRaw, setPayload } from "./access.js";
import { accepts, method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CommandContext } from "./types.js";
import { CusPushEvent } from "../push-events.js";
import type { Command } from "../../core/contracts.js";

/** The station broadcast channel the HomeBase's own controls ride (not a device channel). */
const STATION_CHANNEL = 255;

/**
 * Guard-mode labels the {@link ArmingActions} accept — the values side of `armingMode`'s enum.
 * `ArmingMode` is both the const value-object (`ArmingMode.home`) and the union type of its values,
 * so callers pass the named constant: `setMode(ArmingMode.home)`.
 */
export const ArmingMode = {
  /** Armed — full protection, nobody home (wire value 0). */
  away: "away",
  /** Armed for occupancy — reduced/perimeter protection while home (wire value 1). */
  home: "home",
  /** Follow the configured time schedule; the active mode switches by clock (wire value 2). */
  schedule: "schedule",
  /** User-defined custom profile #1 (wire value 3). */
  custom1: "custom1",
  /** User-defined custom profile #2 (wire value 4). */
  custom2: "custom2",
  /** User-defined custom profile #3 (wire value 5). */
  custom3: "custom3",
  /** Geofence-driven — arms/disarms as your phone leaves/enters the location (wire value 47). */
  geo: "geo",
  /** Disarmed — no alarms; sensors still report state (wire value 63). */
  disarmed: "disarmed",
} as const;
export type ArmingMode = (typeof ArmingMode)[keyof typeof ArmingMode];

/**
 * The P2P **feature-command ids** this arming capability drives. Capability-owned wire vocabulary
 * (transport forwards `cmd.param` opaquely; full id→name catalog in the generated
 * `transport/p2p/commands.ts`).
 */
export const ARMING_CMD = {
  /**
   * Guard/arming mode (app `GUARD_MODE`). ✅ Wire ENVELOPE verified live on a T8030 (
   * 2026-07-23), cycling Away→Disarmed→Home in the
   * real app: `1350` SET_PAYLOAD, cmd 1224 (SAME id as the read param), mChannel 0, explicit
   * mValue3:0, `payload:{mode_type:<int>, user_name:<string>}`.
   *
   * ⚠️ Only 3 of the 8 {@link ArmingMode} values were exercised in that capture — `mode_type` 0
   * (away), 63 (disarmed), 1 (home), all confirmed byte-exact. `schedule`/`custom1`/`custom2`/
   * `custom3`/`geo` (2/3/4/5/47) are third-party-sourced integers the user has confirmed exist as real
   * options in the app UI, but their WIRE VALUES were never captured — a wrong integer among those 5
   * would dispatch as a normal fire-and-forget write and look like success. See
   * `ARMING_MODE_WIRE` for the per-value breakdown.
   */
  SET_ARMING: 1224,
  /**
   * The per-mode alarm/arm-delay configuration write. ✅ WIRE CAPTURED live on a T8030 (
   * 2026-07-23, both directions): a **bare
   * JSON frame, no `1350`/`1700` envelope** — outer P2P cmd IS `1255` itself, station channel 255,
   * plaintext `{account_id, count_down_alarm:{channel_list,delay_time},
   * count_down_arm:{channel_list,delay_time}, devices:[{action,device_channel}], mode_id,
   * siren_sensor_action:[{action,device_channel}]}`.
   *
   * **Disambiguated from a live-countdown-state echo** (2026-07-23): a full arm→wait-through-exit-
   * delay→disarm cycle produced ZERO traffic on this cmd, while every edit of the app's "Alarm Delay"
   * screen did — so this is a genuine settings WRITE, not a realtime push.
   *
   * **Why `setAlarmDelayConfig` takes the FULL config, not just a duration**: `channelList` identifies
   * WHICH sensor channels get the delay (confirmed: setting 45s on one specific sensor produced
   * `channel_list:[<that sensor's channel>], delay_time:45`) — it is not a simple on/off. The
   * corresponding GET command (`1310`/inner cmd `40003`, sent by the app right before editing) always
   * replied `{count:0,data:null}` in every capture — genuinely empty, not a decrypt failure (confirmed
   * via the same bidirectional decrypt this finding used) — so the app does NOT read the current
   * config this way; how it does is still unknown. Without a working GET, safely PATCHING just one
   * channel in or out of an existing list isn't possible without risking clobbering the rest — so
   * this ships as a caller-supplies-everything write instead of guessing a merge.
   * `devices`/`siren_sensor_action` are even less understood (raw per-device action codes, meaning
   * unconfirmed) and MUST come from a value you've independently read/captured for the target mode —
   * see `AlarmDelayConfig`'s field docs.
   */
  ALARM_DELAY_CONFIG: 1255,
} as const;

/**
 * Guard-mode name → the wire's `mode_type` integer. Fixed (not model-dependent) — the single source
 * of truth {@link ARMING_MODE_LABELS} (the `armingMode` PropertySpec's `enumValues`) derives from.
 *
 * ✅ WIRE-CAPTURED (byte-exact, a T8030 2026-07-23): `away` 0, `home` 1, `disarmed` 63.
 * ⚠️ NOT WIRE-CAPTURED: `schedule` 2, `custom1` 3, `custom2` 4, `custom3` 5, `geo` 47 — unverified
 * third-party-sourced integers only. The user has confirmed all 5 exist as real picker options in the app, but a write
 * using one of these is UNVERIFIED — if the real integer differs, it dispatches as a normal
 * fire-and-forget write and looks like success. Flip this note (and {@link ARMING_CMD.SET_ARMING})
 * once each is captured.
 */
const ARMING_MODE_WIRE: Record<ArmingMode, number> = {
  away: 0,
  home: 1,
  schedule: 2, // ⚠️ unverified — see the doc comment above
  custom1: 3, // ⚠️ unverified — see the doc comment above
  custom2: 4, // ⚠️ unverified — see the doc comment above
  custom3: 5, // ⚠️ unverified — see the doc comment above
  geo: 47, // ⚠️ unverified — see the doc comment above
  disarmed: 63,
};

/**
 * The `armingMode` PropertySpec's `enumValues` (wire int → label) — derived from
 * `ARMING_MODE_WIRE` instead of hand-listed a second time, so the two can't drift out of sync.
 */
const ARMING_MODE_LABELS: Record<number, string> = enumLabels(ARMING_MODE_WIRE);

/**
 * The mode a caller named, from EITHER vocabulary: the name (`"away"`) or the wire integer the `mode`
 * getter answers (`0`).
 *
 * The getter's value has to be settable back. Matching names alone made `setMode(dev.arming().mode)`
 * refuse every time, with a generated message that listed as valid exactly the integer it had just
 * rejected — the getter publishes {@link ARMING_MODE_LABELS}, keyed by wire value, as its own domain.
 */
function armingModeOf(v: boolean | number | string): ArmingMode | undefined {
  const name = String(v);
  if (name in ARMING_MODE_WIRE) return name as ArmingMode;
  const wire = Number(v);
  return (Object.keys(ARMING_MODE_WIRE) as ArmingMode[]).find((m) => ARMING_MODE_WIRE[m] === wire);
}

/**
 * Build the {@link ARMING_CMD.SET_ARMING} write intent, or throw if the context has no account
 * identity. `user_name` — the real app's own capture showed a MASKED value (`"max***"`, presumably
 * the app's own privacy-display truncation of the account's email local-part), not the raw
 * local-part `ctx.accountName` holds. Untested whether the device validates this field strictly;
 * sending our real (unmasked) identity is the more correct choice regardless — it's almost certainly
 * just attribution (e.g. "who armed the system" in event history), not a value the device checks
 * against anything.
 */
function armingCommand(mode: ArmingMode, ctx: CommandContext): Command {
  const modeType = ARMING_MODE_WIRE[mode];
  if (!ctx.accountName) {
    throw new Error(`arming: missing account identity (user_name) [${describeDevice(ctx)}]`);
  }
  return setPayload(ARMING_CMD.SET_ARMING, { mode_type: modeType, user_name: ctx.accountName }, ctx, 0);
}

/**
 * Alarm-delay durations the app's OWN picker UI offers — `AlarmDelaySeconds` is both the const
 * value-object (`AlarmDelaySeconds.sec45`) and the union type of its values, so callers pass the
 * named constant: `{delaySeconds: AlarmDelaySeconds.sec45}`.
 *
 * **NOT a wire constraint** — the device itself does NOT validate against this list: a live test sent
 * `50` (off this list) and the app reflected it correctly, no rejection. Typed as a closed set anyway
 * so `setAlarmDelayConfig` callers get the same choices a human editing the same setting in the app
 * would see, rather than an arbitrary int that could silently diverge from every value the real UI
 * can actually produce (and so a caller doesn't have to guess what's "sane" — these ARE all of them).
 */
export const AlarmDelaySeconds = {
  off: 0,
  sec15: 15,
  sec30: 30,
  sec45: 45,
  sec60: 60,
  min3: 180,
  min5: 300,
} as const;
export type AlarmDelaySeconds = (typeof AlarmDelaySeconds)[keyof typeof AlarmDelaySeconds];

/** One `channelList`+`delaySeconds` countdown pair — see {@link AlarmDelayConfig}. */
export type AlarmDelayCountdown = {
  /** Device channels this countdown applies to. */
  channelList: number[];
  /** Delay duration — one of {@link AlarmDelaySeconds}, shared across every channel in `channelList`. */
  delaySeconds: AlarmDelaySeconds;
};

/** One device's participation entry in {@link AlarmDelayConfig.devices} / `.sirenSensorAction`. */
export type AlarmDelayDeviceAction = {
  deviceChannel: number;
  /** Raw per-device action code. Meaning NOT independently confirmed — pass through verbatim from a
   * value you've read/captured for this exact mode, never invented. */
  action: number;
};

/**
 * The FULL per-mode alarm/arm-delay configuration the device accepts as one write — see the
 * `setAlarmDelayConfig` doc for why this is a caller-supplies-everything shape rather than a simple
 * `setEntryDelay(seconds)` toggle.
 */
export type AlarmDelayConfig = {
  /** Per-sensor ENTRY/alarm delay — the app's "Alarm Delay" UI setting. Confirmed on-device: a delay
   * set on one sensor lands as that sensor's channel plus the chosen duration. */
  countDownAlarm: AlarmDelayCountdown;
  /** A second, distinct countdown carried alongside `countDownAlarm`. It stayed empty across every
   * observed `countDownAlarm` edit, so its own trigger condition is UNCONFIRMED. */
  countDownArm: AlarmDelayCountdown;
  /** Every device's participation + action for THIS mode. UNCONFIRMED semantics (the action code's
   * meaning is unknown) — it stayed identical across every `countDownAlarm`-only edit within the same
   * mode, so pass through exactly what you read back for that mode; never invent a value. */
  devices: AlarmDelayDeviceAction[];
  /** Siren behavior per device for this mode. Same caveat as `devices`. */
  sirenSensorAction: AlarmDelayDeviceAction[];
};

/**
 * Build the alarm-delay `cmd 1255` write intent. Bare JSON, no envelope (`setJsonRaw`) — see
 * the full config. Pinned to the station broadcast channel (255), NOT
 * `ctx.channel` (which resolves to 0 for a station context) — the capture put this frame on channel
 * 255 explicitly, same as every other station-scoped bare/scalar write in the router.
 */
function alarmDelayCommand(mode: ArmingMode, config: AlarmDelayConfig, ctx: CommandContext): Command {
  const data = {
    mode_id: ARMING_MODE_WIRE[mode],
    count_down_alarm: {
      channel_list: config.countDownAlarm.channelList,
      delay_time: config.countDownAlarm.delaySeconds,
    },
    count_down_arm: { channel_list: config.countDownArm.channelList, delay_time: config.countDownArm.delaySeconds },
    devices: config.devices.map((d) => ({ action: d.action, device_channel: d.deviceChannel })),
    siren_sensor_action: config.sirenSensorAction.map((d) => ({ action: d.action, device_channel: d.deviceChannel })),
  };
  return setJsonRaw(ARMING_CMD.ALARM_DELAY_CONFIG, data, ctx, STATION_CHANNEL);
}

/**
 * Bound guard-mode controls — the object returned by `dev.arming()`.
 *
 * Everything is DERIVED from `ARMING_MEMBERS`. `setMode` is the mode member's own derived setter;
 * `setAlarmDelayConfig` is a `method` because it takes TWO arguments (a mode and a whole config),
 * which no value setter can express.
 */
export type ArmingActions = Surface<typeof ARMING_MEMBERS>;

/**
 * Every `arming` feature, declared once.
 *
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const ARMING_MEMBERS = {
  /**
   * A mode outside `ARMING_MODE_WIRE` resolves to nothing, so the derived `setMode` refuses rather
   * than sending an integer no capture supports. `armingCommand` may also throw synchronously (missing
   * account identity) and `bindMembers` turns that into a rejection, so the builder stays plain.
   *
   * The setter takes either vocabulary — see `armingModeOf` — because the getter answers the wire
   * integer, and a value a caller just read has to be one it can write back.
   */
  mode: {
    param: ARMING_CMD.SET_ARMING,
    property: "armingMode",
    type: "enum",
    kind: "enum",
    enumValues: ARMING_MODE_LABELS,
    provenance: "verified",
    description:
      "Guard mode (verified: param 1224 = GUARD_MODE, read/write mechanism confirmed). Only 3 of the " +
      "8 enum values are wire-captured (away/home/disarmed) — schedule/custom1/custom2/custom3/geo " +
      "are unverified third-party-sourced integers, confirmed to exist in the app UI but not captured on the wire; " +
      "see ARMING_MODE_WIRE in arming.ts for the per-value breakdown.",
    write: (v, ctx) => {
      const mode = armingModeOf(v);
      return mode ? armingCommand(mode, ctx) : undefined;
    },
    ...accepts<ArmingMode>(),
  },

  /**
   * Write the FULL per-mode alarm/arm-delay configuration. The device accepts the whole config as one
   * write, not a single duration field, so a partial update is not possible. An expert/advanced API: the
   * caller is responsible for supplying `devices`/`sirenSensorAction` (and the `countDownAlarm`/
   * `countDownArm` entries they are NOT changing) from a value they have independently read/captured for
   * this mode — there is no known GET to fetch it automatically, and a wrong guess here can silently
   * misconfigure which sensors arm/trigger for real.
   */
  setAlarmDelayConfig: method(
    ({ ctx, sink }) =>
      (mode: ArmingMode, config: AlarmDelayConfig): Promise<void> => {
        try {
          return sink.dispatch(alarmDelayCommand(mode, config, ctx));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    "Write the full per-mode alarm/arm-delay configuration.",
  ),
} as const satisfies Members;

/**
 * `arming` — guard/arming mode. `armingMode` (see {@link ARMING_CMD.SET_ARMING}) has a verified
 * read/write MECHANISM, but only 3 of its 8 {@link ArmingMode} values (away/home/disarmed) are
 * wire-captured — see `ARMING_MODE_WIRE` for which 5 are still unverified third-party integers.
 */
export const ARMING: CapabilityModule = {
  capability: "arming",
  description: "Station/device guard (arming) mode.",
  members: ARMING_MEMBERS,
  properties: propertiesOf(ARMING_MEMBERS),
  // A reported guard-mode param is the verified proof; every station-codec device also owns an
  // arming surface as part of its baseline.
  detection: { evidenceParams: [ARMING_CMD.SET_ARMING], codecs: ["station"] },
  ownedByStation: true,
  /**
   * Station-scoped push events. The hub reports a guard-mode switch and the alarm lifecycle on the
   * generic `CusPushEvent` channel, so these ids are shared with other families and resolve by
   * capability (see the barrel's event index).
   *
   * The alarm ids carry a static `phase` so one event name covers the whole lifecycle, the same shape
   * `battery` uses for its threshold pushes. The mode-switch push is known to identify WHICH mode and
   * what triggered the change, but neither has been observed on the wire here, so this emits the bare
   * transition and a host re-reads the mode rather than trusting a decoded field.
   */
  events: [
    { source: "push", match: CusPushEvent.MODE_SWITCH, emit: "armingModeChanged" },
    { source: "push", match: CusPushEvent.ALARM, emit: "alarm", payload: { phase: "triggered" } },
    { source: "push", match: CusPushEvent.ALARM_DELAY, emit: "alarm", payload: { phase: "delayed" } },
  ],
};
