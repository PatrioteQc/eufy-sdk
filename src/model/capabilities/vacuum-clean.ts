import type { RawDpCodec, RawDpField } from "../../core/contracts.js";
import type { ParamValue } from "../types.js";
import type { AvailabilityContext, CapabilityModule } from "./types.js";
import { asBool } from "../../core/util.js";
import { isAiotVacuum, isTuyaVacuum } from "../device-family.js";
import { pickDpParams, aiotDp } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";

/**
 * RoboVac Tuya **DP ids** this capability reads — the "clean" namespace (ids ~150-180, from the cloud
 * `get_product_data_point` schema). Named here so each DP is referenced by meaning rather than a magic
 * number, the same way the P2P capabilities name their feature-command ids (`CAMERA_CMD`, `LIGHT_CMD`).
 * Values confirmed against a live T2351 DP dump.
 */
export const VACUUM_DP = {
  /** Power on/off (DP 151 power switch, Bool). */
  POWER: 151,
  /** WorkStatus (DP 153 work status, Raw protobuf) — carries the activity in field #2 (see {@link decodeVacuumActivity}). */
  WORK_STATUS: 153,
  /** ModeCtrlRequest (DP 152, Raw protobuf) — carries the mode-control command (start/pause/dock). */
  MODE_CTRL: 152,
  /** CleanParam (DP 154 clean params, Raw protobuf) — carries the cleaning type (see {@link decodeCleanType}). */
  CLEAN_PARAM: 154,
  /** Speaker volume 0-100 (DP 161, Value). */
  VOLUME: 161,
  /** Device UI language (DP 162, String rw). Locale code set by the app, e.g. "en", "zh", "de". */
  LANGUAGE: 162,
  /** Battery level 0-100 (DP 163, Value) — a clean-namespace DP, NOT the security param 1101. */
  BATTERY: 163,
  /** UndisturbedResponse (DP 157, Raw protobuf) — the do-not-disturb window (see {@link decodeDoNotDisturb}). */
  DO_NOT_DISTURB: 157,
  /** CleanStatistics (DP 167, Raw protobuf) — session and lifetime totals (see {@link decodeCleanStat}). */
  CLEAN_STATS: 167,
  /** ConsumableRuntime (DP 168, Raw protobuf) — hours used per replaceable part (see {@link decodeConsumableHours}). */
  CONSUMABLES: 168,
  /** UnisettingResponse (DP 176, Raw protobuf) — the device-wide setting toggles (see {@link decodeUnisetting}). */
  SETTINGS: 176,
  /** ErrorCode (DP 177 fault alert, Raw protobuf) — the robot's faults and warnings (see {@link decodeVacuumFault}). */
  FAULT_ALERT: 177,
} as const;

/**
 * Legacy Tuya DP ids for the G-series / X8 / L-series clean line.
 * DP 101 confirmed (`goHome` → bool). DP 2 type confirmed (bool play/pause).
 * DPs 104 and 106 confirmed as integer read-only values from protocol inspection.
 * @internal
 */
export const LEGACY_VACUUM_DP = {
  /** Play/pause toggle (DP 2, Bool rw) — true = start, false = pause. */
  PLAY_PAUSE: 2,
  /** Go home (DP 101, Bool rw). */
  GO_HOME: 101,
  /** Battery level 0-100 (DP 104, Int ro). */
  BATTERY_LEVEL: 104,
  /** Error code, 0 = ok (DP 106, Int ro). */
  ERROR_CODE: 106,
} as const;

/**
 * Tuya DP ids for the `eufy_home_tuya` vacuum category (X8 Pro, X-series, and future Tuya clean-line models).
 *
 * Full schema sourced from `thing.m.device.ref.info.list` v5.4 for product `wahqax6ifjgs1c4n`
 * (schemaInfo.schema, 39 DPs). Only the DPs with confirmed read-side values from a live
 * `thing.m.device.dp.get` call are included here. Write direction for all DPs is unverified —
 * no live publishDps capture has been made yet.
 * @internal
 */
export const TUYA_VACUUM_DP = {
  /** Power on/off (DP 1, Bool). */
  POWER: 1,
  /** Play/pause toggle (DP 2, Bool rw) — true = start, false = pause. Shared with {@link LEGACY_VACUUM_DP.PLAY_PAUSE}. */
  PLAY_PAUSE: 2,
  /** Manual direction jog (DP 3, Enum: "forward"|"back"|"left"|"right"). */
  DIRECTION: 3,
  /** Cleaning mode (DP 5, Enum: "auto"|"room"|"zone"|"spot"|"fast_mapping"). Live-confirmed "auto". */
  MODE: 5,
  /** Work status (DP 15, Enum string) — the high-level activity. Live-confirmed "Sleeping". */
  WORK_STATUS: 15,
  /** Return to dock (DP 101, Bool rw). Shared with {@link LEGACY_VACUUM_DP.GO_HOME}. */
  GO_HOME: 101,
  /** Suction/cleaning strength (DP 102, Enum: "Off"|"Quiet"|"Standard"|"Turbo"|"Max"). Live-confirmed "Off". */
  CLEANING_STRENGTH: 102,
  /** Battery level 0-100 (DP 104, Value ro). Shared with {@link LEGACY_VACUUM_DP.BATTERY_LEVEL}. */
  BATTERY_LEVEL: 104,
  /** Mop water flow (DP 105, Enum: "Dry"|"Low"|"Mid"|"High"). Live-confirmed "Mid". */
  MOP_WATER: 105,
  /** Fault code, 0 = ok (DP 106, Value ro). Shared with {@link LEGACY_VACUUM_DP.ERROR_CODE}. */
  FAULT_REPORT: 106,
  /** Do-not-disturb / forbid mode (DP 107, Bool). Live-confirmed false. */
  FORBID_MODE: 107,
  /** Session cleaning time in seconds (DP 109, Value). Live-confirmed 4200 (= 70 min). */
  CLEAR_TIME: 109,
  /** Session cleaned area in m² (DP 110, Value). Live-confirmed 54. */
  CLEAR_AREA: 110,
  /** Speaker loudness 0-100 (DP 111, Value). Live-confirmed 38. */
  LOUDNESS: 111,
  /** Configured cleaning type (DP 113, Enum: "Sweep"|"SweepMop"|"Mop"). Live-confirmed "Sweep". */
  CLEAN_TYPE: 113,
  /** Total lifetime cleaning time in seconds (DP 119, Value). */
  CLEAR_TOTAL_TIME: 119,
  /** Total lifetime cleaned area in m² (DP 120, Value). */
  CLEAR_TOTAL_AREA: 120,
  /** Water tank attached (DP 127, Bool ro). */
  WATER_TANK_STATUS: 127,
  /** Mop pad attached (DP 129, Bool ro). */
  MOP_STATUS: 129,
  /** WiFi RSSI in dBm (DP 134, Value). */
  RSSI: 134,
} as const;

/**
 * `thing.m.device.ref.info.list` v5.4 `schemaInfo.schema` confirmed values for DP 15 (status).
 *
 * Exported so a caller can offer the set as data; not published — `VacuumActivity` is the
 * union that matters externally.
 * @internal
 */
export const TUYA_WORK_STATUS_VALUES = [
  "standby",
  "Running",
  "Sleeping",
  "Recharge",
  "Charging",
  "completed",
  "Goto",
  "Locating",
  "Collecting",
  "RollAutoCleaning",
  "CC_Recharge",
  "CC_Charging",
] as const;

/**
 * Confirmed values for DP 5 (mode) from schemaInfo.schema.
 * @internal
 */
export const TUYA_WORK_MODES = ["auto", "room", "zone", "spot", "fast_mapping"] as const;
/** @internal */
export type TuyaWorkMode = (typeof TUYA_WORK_MODES)[number];

/**
 * Confirmed values for DP 102 (cleaning_strength) from schemaInfo.schema. Live-confirmed "Off".
 * @internal
 */
export const TUYA_CLEANING_STRENGTHS = ["Off", "Quiet", "Standard", "Turbo", "Max"] as const;
/** @internal */
export type TuyaCleaningStrength = (typeof TUYA_CLEANING_STRENGTHS)[number];

/**
 * Confirmed values for DP 105 (MopWater) from schemaInfo.schema. Live-confirmed "Mid".
 * @internal
 */
export const TUYA_MOP_WATER_LEVELS = ["Dry", "Low", "Mid", "High"] as const;
/** @internal */
export type TuyaMopWaterLevel = (typeof TUYA_MOP_WATER_LEVELS)[number];

/**
 * Confirmed values for DP 113 (CleanType) from schemaInfo.schema. Live-confirmed "Sweep".
 * @internal
 */
export const TUYA_CLEAN_TYPES = ["Sweep", "SweepMop", "Mop"] as const;
/** @internal */
export type TuyaCleanType = (typeof TUYA_CLEAN_TYPES)[number];

/**
 * `ModeCtrlRequest.method` values for DP 152. Live-verified on T2351: START_AUTO_CLEAN → 0
 * (omitted from the wire when zero), START_GOHOME → 6, PAUSE_TASK → 13.
 */
export const ModeCtrlMethod = {
  START_AUTO_CLEAN: 0,
  START_GOHOME: 6,
  PAUSE_TASK: 13,
} as const;

/**
 * Encode a `ModeCtrlRequest` protobuf (DP 152) as a base64 string: `varint(bodyLen) ++ body`
 * where `body = {field#1:method, field#2:seq}`.
 *
 * Uses a hand-rolled varint rather than importing protobufjs — the model layer may not import
 * transport deps and the field count is small enough to inline. Method 0 (START_AUTO_CLEAN) is
 * omitted from the wire per the proto3 default-field rule (confirmed on a live T2351 capture).
 * @internal
 */
export function encodeModeCtrl(method: number, seq: number): string {
  const writeVarint = (buf: number[], n: number): void => {
    let v = n;
    while (v > 0x7f) {
      buf.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    buf.push(v);
  };
  const body: number[] = [];
  if (method !== 0) {
    body.push(0x08); // field 1, wire type 0 (varint)
    writeVarint(body, method);
  }
  body.push(0x10); // field 2, wire type 0 (varint)
  writeVarint(body, seq);
  const out: number[] = [];
  writeVarint(out, body.length);
  return Buffer.from([...out, ...body]).toString("base64");
}

/**
 * Every value {@link VacuumActivity} can take, as data — the read's declared domain, so the schema a
 * caller reads and the type it compiles against are the same list rather than two that can drift.
 *
 * Exported so a caller can offer the set as data; not published — `VacuumActivity` is the union a
 * reader of the reference needs, and it states the same members.
 * @internal
 */
export const VACUUM_ACTIVITIES = ["idle", "error", "docked", "cleaning", "returning", "paused", "unknown"] as const;

/**
 * The robot's high-level activity — what `dev.vacuumClean()?.activity` reports. `"unknown"` covers a
 * status the SDK can't classify yet. `"cleaning"` is the widest member: it also covers mapping,
 * cruising and manual remote driving, which the wire distinguishes and this union does not.
 */
export type VacuumActivity = (typeof VACUUM_ACTIVITIES)[number];

/**
 * DP 15 wire string → {@link VacuumActivity} for the X8 Pro.
 *
 * Values from schemaInfo.schema (`thing.m.device.ref.info.list` v5.4, product `wahqax6ifjgs1c4n`).
 * Live-confirmed "Sleeping" at rest. The sSchema.statusSchemaList confirms six of these:
 * Sleeping→sleep, Running→cleaning, Recharge→goto_charge, Charging→charging, completed→charge_done,
 * standby→standby. The remaining six (Goto / Locating / Collecting / RollAutoCleaning / CC_Recharge /
 * CC_Charging) are schema-confirmed but not yet live-observed — mapped best-effort.
 */
const X8_STATUS_TO_ACTIVITY: Record<string, VacuumActivity> = {
  Sleeping: "idle", // ✅ live X8 Pro; sSchema: sleep
  standby: "idle", // ✅ sSchema: standby
  Running: "cleaning", // ✅ sSchema: cleaning
  Recharge: "returning", // ✅ sSchema: goto_charge
  Charging: "docked", // ✅ sSchema: charging
  completed: "docked", // ✅ sSchema: charge_done
  Goto: "returning", // ⚠️ schema-only
  Locating: "cleaning", // ⚠️ schema-only
  Collecting: "cleaning", // ⚠️ schema-only
  RollAutoCleaning: "cleaning", // ⚠️ schema-only
  CC_Recharge: "returning", // ⚠️ schema-only
  CC_Charging: "docked", // ⚠️ schema-only
};

/**
 * Decode a DP 15 string to a {@link VacuumActivity} for the X8 Pro. Returns `"unknown"` for any
 * value absent from the confirmed schema set, so every valid raw string from the device yields
 * a typed result rather than `undefined`.
 * @internal
 */
export function decodeTuyaWorkStatus(raw: ParamValue | undefined): VacuumActivity {
  if (typeof raw !== "string") return "unknown";
  return X8_STATUS_TO_ACTIVITY[raw] ?? "unknown";
}

/**
 * `WorkStatus.state` (protobuf field #2) → {@link VacuumActivity}.
 *
 * Three values are **live-verified** on a T2351 — a start→return→charge run reported `5`(cleaning) →
 * `7`(returning) → `3`(docked), matching the physical actions. The rest come from the vendor's own
 * `WorkStatus.State` enumeration, which those three corroborate exactly: it declares `CHARGING = 3`,
 * `CLEANING = 5` and `GO_HOME = 7` at the same positions the device reported them.
 *
 * The vendor's remaining names are narrower than this union can express, so several collapse onto
 * `"cleaning"` — the closest true answer for a robot that is off the dock and driving:
 * `FAST_MAPPING`(4) is mapping a floor, `REMOTE_CTRL`(6) is being driven by hand, `CRUISIING`(8) is
 * patrolling. A caller that needs to tell those apart cannot use this read to do it.
 *
 * The enumeration ends at `8`. An earlier revision carried a `15 → "paused"` entry, which no device
 * can report — pause is a **sub-state** of `5`, resolved by {@link resolveCleaningState} rather than by
 * a state of its own.
 */
const WORK_STATE_ACTIVITY: Record<number, VacuumActivity> = {
  0: "idle", // STANDBY — also every paused-* state; the sub-state carries which
  1: "idle", // SLEEP
  2: "error", // FAULT
  3: "docked", // CHARGING ✅ live T2351
  4: "cleaning", // FAST_MAPPING — driving, no narrower member
  5: "cleaning", // CLEANING ✅ live T2351 — refined by resolveCleaningState
  6: "cleaning", // REMOTE_CTRL — driving, no narrower member
  7: "returning", // GO_HOME ✅ live T2351
  8: "cleaning", // CRUISIING — driving, no narrower member
};

/** The one {@link WORK_STATE_ACTIVITY} entry that is not final on its own — see {@link resolveCleaningState}. */
const WORK_STATE_CLEANING = 5;

/**
 * Field numbers inside `WorkStatus` that refine state `5`, and inside the sub-messages they carry.
 *
 * Each sub-message follows the vendor's stated rule: **an absent message means that sub-state is
 * idle**, so presence is the signal and the fields inside it only narrow further.
 */
const WORK_STATUS_FIELD = {
  /** `state` — the one field read for every other state. */
  STATE: 2,
  /** `cleaning` — carries `state`(1) `DOING`/`PAUSED`. */
  CLEANING: 6,
  /** `go_wash` — carries `mode`(2) `NAVIGATION`/`WASHING`/`DRYING`. */
  GO_WASH: 7,
  /** `station` — carries `washing_drying_system`(3) while the dock runs a mop cycle. */
  STATION: 14,
} as const;

/** `Cleaning.state` — the run state of a cleaning job. `DOING` is the proto3 default, so it is absent on the wire. */
const CLEANING_STATE_PAUSED = 1;

/** `GoWash.mode` values that mean the robot is parked ON the dock rather than driving toward it. */
const GO_WASH_ON_DOCK = new Set([1, 2]);

/** `Station.washing_drying_system` — present while the dock is washing or drying mops. */
const STATION_WASHING_DRYING = 3;

/** `mode`'s field number inside `GoWash` — which leg of the wash cycle the robot is in. */
const SUB_MODE_FIELD = 2;

/** `state`'s field number inside `Cleaning` — whether the job is running or paused. */
const SUB_STATE_FIELD = 1;

/**
 * Read one `uint32`-valued field out of a nested sub-message, or `0` when it is absent.
 *
 * Absent is not missing data: proto3 omits a zero-valued field, so an empty sub-message states the
 * enum's zero member — `DOING` for a run state, `NAVIGATION` for a wash mode — and reading it as `0`
 * is what the encoding means.
 */
function subValue(codec: RawDpCodec, body: Buffer, field: number): number {
  const found = codec.nested(body)?.find((f) => f.field === field);
  return found?.kind === "int" ? Number(found.value) : 0;
}

/**
 * Refine `WorkStatus.state == 5` into the activity the robot is actually in.
 *
 * State `5` is not one state. The vendor's own enumeration lists it as covering positioning, global
 * and area cleaning, spot cleaning **and** returning-to-wash / washing mops — and the sub-messages
 * beside it are what separate those. Without this, a paused robot and one parked on its dock running a
 * wash cycle both read as `"cleaning"`, which is the single most visible wrong answer this capability
 * can give.
 *
 * Resolution order matters, and follows the device's own precedence: being **on** the dock beats being
 * paused, because a robot that paused itself to go wash reports both. `go_wash` with a driving mode
 * (`NAVIGATION`) is deliberately NOT docked — it is still en route.
 *
 * Falls through to `"cleaning"` whenever no sub-message claims it, so a frame this does not recognise
 * degrades to the previous behaviour rather than to a worse one.
 *
 * **The station branch is the softest read here, and the one to confirm on-device first.** It takes the
 * PRESENCE of `washing_drying_system` as washing-or-drying and does not read its value, where `go_wash`
 * above reads the actual mode. That follows the schema's own "an absent message is IDLE" rule, and it
 * degrades into the `"cleaning"` fallback rather than into a wrong dock state — but unlike the go_wash
 * and paused branches it is not corroborated by a capture, so a live report of a robot washing at its
 * dock is what would settle whether presence alone is enough.
 */
function resolveCleaningState(fields: readonly RawDpField[], codec: RawDpCodec): VacuumActivity {
  const sub = (field: number): Buffer | undefined => {
    const found = fields.find((f) => f.field === field);
    return found?.kind === "bytes" ? found.value : undefined;
  };

  const goWash = sub(WORK_STATUS_FIELD.GO_WASH);
  if (goWash && GO_WASH_ON_DOCK.has(subValue(codec, goWash, SUB_MODE_FIELD))) return "docked";

  const station = sub(WORK_STATUS_FIELD.STATION);
  if (station && codec.nested(station)?.some((f) => f.field === STATION_WASHING_DRYING)) return "docked";

  const cleaning = sub(WORK_STATUS_FIELD.CLEANING);
  if (cleaning && !goWash && subValue(codec, cleaning, SUB_STATE_FIELD) === CLEANING_STATE_PAUSED) return "paused";

  return "cleaning";
}

/**
 * Every value {@link VacuumCleanType} can take — the read's declared domain, see `VACUUM_ACTIVITIES`.
 *
 * Exported so a caller can offer the set as data; not published, like `VACUUM_ACTIVITIES`.
 * @internal
 */
export const VACUUM_CLEAN_TYPES = ["sweep", "mop", "sweepAndMop", "sweepThenMop"] as const;

/**
 * What the robot is **set** to do with a surface — `dev.vacuumClean()?.cleanType`. This is the setting,
 * not what a job in progress is doing; the two disagree while a change is being applied.
 *
 * `mop` and `sweepAndMop` are verified on a real robot. `sweepThenMop` comes from the vendor's own
 * enumeration and has not been observed on a device yet. `"sweep"` also covers **"no type stated"** —
 * a robot that states none is indistinguishable from one set to sweep-only, so a host that needs to
 * tell those apart cannot use this read to do it.
 */
export type VacuumCleanType = (typeof VACUUM_CLEAN_TYPES)[number];

/** `CleanType.value` → {@link VacuumCleanType}, per the vendor's `CleanType.Value` enum. */
const CLEAN_TYPE: Record<number, VacuumCleanType> = {
  0: "sweep",
  1: "mop", // ✅ live T2351
  2: "sweepAndMop", // ✅ live T2351
  3: "sweepThenMop", // ⚠️ unverified — vendor enum, not yet observed
};

/**
 * Field numbers inside `CleanParamResponse` and its nested `CleanParam`.
 *
 * A T2351 sends all four top-level containers on every report, present-but-empty when they carry
 * nothing — so container presence proves nothing and only the fields INSIDE it do. `CONFIGURED` is the
 * device's setting; `RUNNING` is what the job in progress is actually doing, and the two disagree
 * mid-change. This reads the setting, which is what the app's own screen shows.
 */
const CLEAN_PARAM_FIELD = {
  /** `clean_param` — the configured parameters. */
  CONFIGURED: 1,
  /** `clean_type` within a `CleanParam`. */
  CLEAN_TYPE: 1,
  /** `clean_carpet` — what to do when the robot meets a carpet. */
  CLEAN_CARPET: 2,
  /** `clean_extent` — how far past the mapped edge to go. */
  CLEAN_EXTENT: 3,
  /** `smart_mode_sw` — the robot's own judgement about a room, on or off. */
  SMART_MODE: 5,
  /** `clean_times` — how many passes one job makes. */
  CLEAN_TIMES: 7,
  /** `value` within a `CleanType`. */
  VALUE: 1,
} as const;

/** `clean_carpet.strategy` — what the robot does when it meets a carpet. */
export const CARPET_STRATEGIES = ["autoRaise", "avoid", "ignore"] as const;
export type CarpetStrategy = (typeof CARPET_STRATEGIES)[number];
const CARPET_STRATEGY: Record<number, CarpetStrategy> = { 0: "autoRaise", 1: "avoid", 2: "ignore" };

/**
 * `clean_extent.value` — how far past the mapped edge a job reaches.
 *
 * **Not the app's display order.** The app lists these differently, so a host that renders the index
 * rather than the name will disagree with the phone; the names here follow the wire, which is the only
 * order this SDK can vouch for.
 */
export const CLEAN_EXTENTS = ["normal", "narrow", "quick"] as const;
export type CleanExtent = (typeof CLEAN_EXTENTS)[number];
const CLEAN_EXTENT: Record<number, CleanExtent> = { 0: "normal", 1: "narrow", 2: "quick" };

/**
 * Read one setting out of the CONFIGURED `CleanParam` (DP 154), by its field number.
 *
 * The generalisation of {@link decodeCleanType}, and it reads the same container for the same reason:
 * a report taken mid-change carries a different value in `clean_param`(1) and `running_clean_param`(4),
 * and the SETTING is the stable answer.
 *
 * **How the inner value is found, and why it is not a second field number.** The vendor wraps each
 * setting in its own single-field message — `CleanType{value}`, `CleanCarpet{strategy}`,
 * `CleanExtent{value}` — where the wrapper's name and its field's name differ per setting but the
 * shape does not. Rather than assert a number for each inner field, this takes the FIRST varint the
 * wrapper carries. The 1→1→1 nesting is live-proven for `clean_type`; taking the first scalar is what
 * extends that to its siblings without claiming a number for any of them.
 *
 * The cost is stated rather than hidden: a wrapper that ever carries more than one scalar would read
 * its first, so this is only used for the settings documented as single-valued. `mop_mode`(4) carries
 * both a level and a corner-clean flag and is deliberately NOT read here for that reason.
 *
 * A present-but-empty wrapper answers `0` — proto3 omits a zero, so the enum's zero member and "the
 * wrapper said nothing" are the same bytes. An absent wrapper is `undefined`: the device did not state
 * this setting at all.
 * @internal
 */
export function decodeCleanParamValue(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): number | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const configured = codec.decode(raw)?.find((f) => f.field === CLEAN_PARAM_FIELD.CONFIGURED);
  if (configured?.kind !== "bytes" || !configured.value.length) return undefined;
  const setting = codec.nested(configured.value)?.find((f) => f.field === field);
  if (setting === undefined) return undefined;
  if (setting.kind === "int") return Number(setting.value);
  if (!setting.value.length) return 0;
  const value = codec.nested(setting.value)?.find((f) => f.kind === "int");
  return value === undefined ? 0 : Number(value.value);
}

/**
 * Decode the cleaning type out of a `CleanParam` (DP 154) Raw-DP value.
 *
 * Reads the CONFIGURED container, not the running one: a report mid-change carries a different type in
 * each, and the setting is the stable answer. Every level is presence-checked rather than defaulted —
 * the vendor wraps each enum in its own single-field message precisely so that a wrapper's presence
 * says "this was stated", and an absent wrapper yields `undefined` rather than a fabricated `"sweep"`.
 *
 * **Known ambiguity, unresolvable on the wire.** The protocol omits zero-valued fields, so an empty
 * `CleanType{}` and an explicit `SWEEP_ONLY` are the same bytes. Both read as `"sweep"`. A robot that
 * states no type therefore looks like a sweeping robot, and nothing in the payload can distinguish
 * them — resolving it needs a capture of one device with a known-non-sweep setting at rest.
 * @internal
 */
export function decodeCleanType(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
): VacuumCleanType | TuyaCleanType | undefined {
  if (typeof raw !== "string") return undefined;
  // Tuya X8 DP 113 is a plain string enum — detect by value set membership (no overlap with AIoT).
  if ((TUYA_CLEAN_TYPES as readonly string[]).includes(raw)) return raw as TuyaCleanType;
  if (!codec) return undefined;
  const configured = codec.decode(raw)?.find((f) => f.field === CLEAN_PARAM_FIELD.CONFIGURED);
  if (configured?.kind !== "bytes" || !configured.value.length) return undefined;
  const cleanType = codec.nested(configured.value)?.find((f) => f.field === CLEAN_PARAM_FIELD.CLEAN_TYPE);
  if (cleanType?.kind !== "bytes") return undefined;
  if (!cleanType.value.length) return CLEAN_TYPE[0];
  const value = codec.nested(cleanType.value)?.find((f) => f.field === CLEAN_PARAM_FIELD.VALUE);
  if (!value) return CLEAN_TYPE[0];
  return value.kind === "int" ? CLEAN_TYPE[Number(value.value)] : undefined;
}

/**
 * Field numbers inside the `ErrorCode` message (DP 177).
 *
 * Both lists are `repeated uint32`, which proto3 encodes PACKED by default — one length-delimited run
 * of varints rather than one field per value. {@link firstRepeatedCode} reads either form, because a
 * sender is free to emit the unpacked one and a reader that assumed packing would silently see nothing.
 */
const ERROR_CODE_FIELD = {
  /** `error` — faults that stop the robot. */
  ERROR: 2,
  /** `warn` — conditions the robot reports while continuing. */
  WARN: 3,
} as const;

/** No fault: the message decoded and listed neither an error nor a warning. */
const NO_FAULT = 0;

/**
 * Read the first value of a `repeated uint32`, accepting both encodings.
 *
 * Packed arrives as one length-delimited run of varints, unpacked as a plain varint field repeated —
 * so the first match wins in either case. Returns `undefined` when the field is absent or the packed
 * run is empty, which the caller reads as "this list said nothing" rather than as a zero code.
 *
 * **Assumes a code below 2³¹.** The accumulate uses JavaScript's `<<`, which is a 32-bit signed
 * operation, so a wider varint would wrap. Every documented range is four digits — 1-119 robot,
 * 1010-5112 component, 6010-6311 station, 7000-7055 situational — so this holds today and is stated
 * rather than assumed silently, in case the vendor's table ever grows a wider code.
 */
function firstRepeatedCode(fields: readonly RawDpField[], field: number): number | undefined {
  const found = fields.find((f) => f.field === field);
  if (found === undefined) return undefined;
  if (found.kind === "int") return Number(found.value);

  let value = 0;
  let shift = 0;
  for (const byte of found.value) {
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
  return undefined;
}

/**
 * Decode the robot's current fault code from either clean line.
 *
 * The two lines carry the same meaning on different wires, so this discriminates on the value's SHAPE
 * the way {@link decodeCleanType} does: the legacy Tuya line reports DP 106 as a plain integer, the
 * AIoT line reports DP 177 as an `ErrorCode` protobuf.
 *
 * `error` is preferred over `warn`: a fault that stops the robot is the more urgent answer when both
 * are listed. Only the FIRST code of the winning list is answered — the property is one number, and a
 * caller needing the whole set needs a shape this schema cannot express (see the module's members).
 *
 * `0` means the device stated no fault. `undefined` means it did not state one at all — an unbound
 * device, or a payload that does not decode — and the two are deliberately different.
 * @internal
 */
export function decodeVacuumFault(raw: ParamValue | undefined, codec: RawDpCodec | undefined): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!codec) return undefined;
  const fields = codec.decode(raw);
  if (!fields) return undefined;
  return (
    firstRepeatedCode(fields, ERROR_CODE_FIELD.ERROR) ?? firstRepeatedCode(fields, ERROR_CODE_FIELD.WARN) ?? NO_FAULT
  );
}

/**
 * Field numbers inside `UndisturbedResponse` (DP 157) and the messages it nests.
 *
 * `ACTIVE` is deliberately NOT read: it reports whether the window is open right now, which is a
 * different question from whether the feature is switched on, and the latter is what the property means.
 */
const UNDISTURBED_FIELD = {
  /** `active` — the live in-window flag, beside the configured window rather than inside it. */
  ACTIVE: 1,
  /** `undisturbed` — the configured window. */
  UNDISTURBED: 2,
  /** `sw` within an `Undisturbed` — the enable switch. */
  SWITCH: 1,
  /** `value` within a `Switch`. */
  VALUE: 1,
} as const;

/**
 * Decode the do-not-disturb switch from either clean line.
 *
 * Discriminates on the value's SHAPE, as {@link decodeCleanType} and {@link decodeVacuumFault} do: the
 * Tuya line reports DP 107 as a plain bool, the AIoT line reports DP 157 as an `UndisturbedResponse`.
 *
 * A present-but-empty `Switch` reads as `false` rather than as missing — proto3 omits a zero-valued
 * field, so "switched off" and "said nothing about the switch" are the same bytes once the container
 * around them is there. An absent CONTAINER is still `undefined`: that is the device not answering.
 * @internal
 */
export function decodeDoNotDisturb(raw: ParamValue | undefined, codec: RawDpCodec | undefined): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return undefined;
  if (raw === "true" || raw === "false") return raw === "true";
  if (raw === "0" || raw === "1") return raw === "1";
  if (!codec) return undefined;

  const window = codec.decode(raw)?.find((f) => f.field === UNDISTURBED_FIELD.UNDISTURBED);
  if (window?.kind !== "bytes") return undefined;
  const sw = codec.nested(window.value)?.find((f) => f.field === UNDISTURBED_FIELD.SWITCH);
  if (sw === undefined) return false;
  if (sw.kind !== "bytes") return undefined;
  const value = codec.nested(sw.value)?.find((f) => f.field === UNDISTURBED_FIELD.VALUE);
  if (value === undefined) return false;
  return value.kind === "int" ? value.value !== 0n : undefined;
}

/**
 * Decode the live in-window flag from an `UndisturbedResponse` (DP 157).
 *
 * The companion to {@link decodeDoNotDisturb}, which reports whether the feature is switched ON. This
 * one reports whether the quiet window is open RIGHT NOW — two different questions the same DP answers,
 * which is why this member reads its sibling's payload instead of claiming a wire of its own.
 *
 * **Both shapes of `active` are read.** Whether the vendor wraps it in a `Switch` the way `sw` is
 * wrapped, or sends it as a bare bool, is not confirmed — so a varint is taken at face value and a
 * sub-message is opened for its `value`. That is not a guess about which arrives: both readings mean
 * the same flag, so handling either is what removes the guess.
 *
 * The AIoT line only. On the Tuya line DP 107 is a plain bool carrying the SWITCH, and no wire there
 * states the window — so a non-protobuf value answers `undefined` rather than borrowing the switch.
 *
 * An absent `active` beside a present `undisturbed` reads as `false`: proto3 omits a zero, so "the
 * window is not open" and "said nothing about it" are the same bytes once the message is recognisable.
 * An absent `undisturbed` is `undefined` — the payload is not one of these at all.
 * @internal
 */
export function decodeDoNotDisturbActive(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
): boolean | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const fields = codec.decode(raw);
  if (!fields?.some((f) => f.field === UNDISTURBED_FIELD.UNDISTURBED)) return undefined;
  const active = fields.find((f) => f.field === UNDISTURBED_FIELD.ACTIVE);
  if (active === undefined) return false;
  if (active.kind === "int") return active.value !== 0n;
  const value = codec.nested(active.value)?.find((f) => f.field === UNDISTURBED_FIELD.VALUE);
  if (value === undefined) return false;
  return value.kind === "int" ? value.value !== 0n : undefined;
}

/**
 * Field numbers inside `CleanStatistics` (DP 167) — three accumulators, one shape.
 *
 * `single` is the run in progress. Two lifetime accumulators sit beside it: `total`(2), which survives
 * a factory reset, and `user_total`(3), which does not. The USER total is the one read here, because it
 * is the figure the app shows and the one a user recognises — a lifetime that resets when they reset the
 * robot. `total`(2) is left unread rather than unknown.
 *
 * All three carry their fields at the same inner numbers, which is the trap: reading the right field of
 * the wrong container silently reports a lifetime figure as the current run.
 */
const CLEAN_STATS_FIELD = {
  /** `single` — statistics for the current run. */
  SINGLE: 1,
  /** `user_total` — the lifetime accumulator that a factory reset clears. */
  USER_TOTAL: 3,
  /** `clean_duration` within any of them, in seconds. */
  DURATION: 1,
  /** `clean_area` within any of them, in m². */
  AREA: 2,
  /** `clean_count` — completed runs. Only `user_total` carries it. */
  COUNT: 3,
} as const;

/**
 * Read one figure out of a `CleanStatistics` (DP 167), or take a plain number as it stands.
 *
 * Both clean lines answer through this. The legacy Tuya line puts each figure on its own DP as a bare
 * integer; the AIoT line buries all of them in one message. The value's SHAPE says which arrived — the
 * same discrimination {@link decodeCleanType} and {@link decodeVacuumFault} use to span the two lines on
 * one property, and the reason these figures need only one name each rather than one per platform.
 *
 * A present-but-empty container reads as `0`: a robot that has just started a run has cleaned no area,
 * and proto3 omits the zero. An absent container is `undefined` — this device does not report it.
 *
 * **The plain-number passthrough belongs to a member that owns its own Tuya DP**, where that DP carries
 * exactly the figure being asked for. A member with no wire of its own must not use it: its owner may
 * have been installed by a read ALIAS, and it would then be handed another figure entirely — the Tuya
 * DP 109 session duration reported as a lifetime run count. Such a member screens the value first; see
 * `lifetimeCleanCount`.
 * @internal
 */
export function decodeCleanStat(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  container: number,
  field: number,
): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!codec) return undefined;

  const group = codec.decode(raw)?.find((f) => f.field === container);
  if (group?.kind !== "bytes") return undefined;
  const value = codec.nested(group.value)?.find((f) => f.field === field);
  if (value === undefined) return 0;
  return value.kind === "int" ? Number(value.value) : undefined;
}

/**
 * Field numbers inside `UnisettingResponse` (DP 176).
 *
 * The message carries fifteen toggles; only the child lock is read, because the property schema allows
 * one property per data point. **Its REQUEST counterpart numbers the same settings differently** — only
 * `children_lock` sits at 1 in both — so a reader and a writer of this DP can never share a table.
 */
const UNISETTING_FIELD = {
  /** `children_lock` — the one field that shares a number with the request. */
  CHILDREN_LOCK: 1,
  /** `cruise_continue_sw` — resume a cruise after charging. */
  CRUISE_CONTINUE: 2,
  /** `multi_map_sw` — keep more than one saved map. */
  MULTI_MAP: 3,
  /** `ai_see` — the obstacle camera. */
  AI_SEE: 4,
  /** `water_level_sw` — request 5, response 5 differ in the REQUEST; this is the response number. */
  WATER_LEVEL: 5,
  /** `suggest_restricted` — offer restricted-area suggestions. */
  SUGGEST_RESTRICTED: 6,
  /** `deep_mop_corner_sw` — extra corner passes while mopping. */
  DEEP_MOP_CORNER: 7,
  /** `dust_full_remind` — warn when the dust bag is full. */
  DUST_FULL_REMIND: 8,
  /** `live_photo_sw` — capture stills while cleaning. */
  LIVE_PHOTO: 9,
  /** `smart_follow_sw` — the response numbers this 13, the request 12. */
  SMART_FOLLOW: 13,
  /** `value` within a `Switch`. */
  VALUE: 1,
} as const;

/**
 * Decode one `Switch`-wrapped toggle out of a `UnisettingResponse` (DP 176).
 *
 * Every toggle in this message is the same two-level shape — a single-field `Switch` wrapper whose
 * `value` is the bool — so one reader serves all of them and each member only names its field number.
 *
 * **Response numbers only.** The REQUEST counterpart numbers the same settings differently and only
 * `children_lock` sits at 1 in both, so {@link UNISETTING_FIELD} is a read-side table and a writer of
 * this DP must never borrow it. That is the trap this whole message carries; see the constant's doc.
 *
 * A present-but-empty `Switch` reads as `false`: proto3 omits a zero, so "off" and "said nothing about
 * this toggle" are the same bytes once the wrapper is there. An absent wrapper is `undefined` — the
 * device did not report the setting at all.
 * @internal
 */
export function decodeUnisetting(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): boolean | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const toggle = codec.decode(raw)?.find((f) => f.field === field);
  if (toggle?.kind !== "bytes") return undefined;
  const value = codec.nested(toggle.value)?.find((f) => f.field === UNISETTING_FIELD.VALUE);
  if (value === undefined) return false;
  return value.kind === "int" ? value.value !== 0n : undefined;
}

/**
 * Field numbers inside `ConsumableRuntime` (DP 168) — one per replaceable part.
 *
 * **8 and 9 are deliberately unused by the vendor.** Do not renumber around the gap: the parts after it
 * really do sit at 10 and 11, and closing the hole would silently read the wrong counter.
 *
 * Each part is a `Duration { uint32 duration = 1 }` carrying HOURS USED, counting up. The vendor does
 * not send a percentage remaining and this does not invent one — a life expectancy per part is a
 * calibration, not something the device reports, so a host that wants a percentage owns that choice.
 */
const CONSUMABLE_FIELD = {
  SIDE_BRUSH: 1,
  ROLLING_BRUSH: 2,
  FILTER_MESH: 3,
  SCRAPE: 4,
  SENSOR: 5,
  MOP: 6,
  DUSTBAG: 7,
  DIRTY_WATERTANK: 10,
  DIRTY_WATERFILTER: 11,
  /** `duration` within a `Duration`, in hours. */
  DURATION: 1,
} as const;

/**
 * Decode one part's hours-used out of a `ConsumableRuntime` (DP 168).
 *
 * Same two-level shape for every part, so one reader serves all nine and each member names its field.
 *
 * A present-but-empty `Duration` reads as `0`, not as missing: a part fitted and never run has no hours
 * on it, and proto3 omits the zero. An absent `Duration` is `undefined` — this robot does not track
 * that part, which is a real answer for a model that does not have one.
 * @internal
 */
export function decodeConsumableHours(
  raw: ParamValue | undefined,
  codec: RawDpCodec | undefined,
  field: number,
): number | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const part = codec.decode(raw)?.find((f) => f.field === field);
  if (part?.kind !== "bytes") return undefined;
  const duration = codec.nested(part.value)?.find((f) => f.field === CONSUMABLE_FIELD.DURATION);
  if (duration === undefined) return 0;
  return duration.kind === "int" ? Number(duration.value) : undefined;
}

/**
 * Decode a `WorkStatus` (DP 153) Raw-DP value to a {@link VacuumActivity}. That DP carries a whole
 * protobuf message rather than a scalar, so the payload is read through the injected {@link RawDpCodec}:
 * the codec owns the structure, this owns which field number carries which meaning. `"unknown"` covers
 * every way the answer can be absent — an unbound device (no codec), a malformed payload, no
 * `state` field, or a state value missing from {@link WORK_STATE_ACTIVITY}.
 *
 * `CLEANING` is the one state that is not final on its own; {@link resolveCleaningState} reads the
 * sub-messages beside it to separate cleaning from paused and from a mop cycle on the dock.
 * @internal
 */
export function decodeVacuumActivity(raw: ParamValue | undefined, codec: RawDpCodec | undefined): VacuumActivity {
  if (typeof raw !== "string" || !codec) return "unknown";
  const fields = codec.decode(raw);
  const state = fields?.find((f) => f.field === WORK_STATUS_FIELD.STATE);
  if (!fields || state?.kind !== "int") return "unknown";
  const activity = WORK_STATE_ACTIVITY[Number(state.value)];
  if (activity === undefined) return "unknown";
  return activity === "cleaning" && Number(state.value) === WORK_STATE_CLEANING
    ? resolveCleaningState(fields, codec)
    : activity;
}

/**
 * Bound RoboVac reads and controls — the object returned by `dev.vacuumClean()`.
 *
 * All reads, `setPower`, and the three mode-control verbs are DERIVED from `VACUUM_CLEAN_MEMBERS`.
 * Each getter is present only when the device reports the backing DP. `setPower` and the three
 * mode-control verbs are AIoT-only: no Tuya clean-line write has been confirmed on a device, so none
 * is dispatched.
 *
 * Tuya clean-line read members (`lifetimeCleanTime`, `lifetimeCleanArea`, `waterTank`, `mopPad`)
 * are populated only once the device has reported those DPs over MQTT or the initial Tuya DP poll.
 */
export type VacuumCleanActions = Surface<typeof VACUUM_CLEAN_MEMBERS>;

/**
 * Every `vacuum_clean` read plus the writes and mode-control verbs.
 *
 * Every write here is AIoT-only, gated on `isAiotVacuum`: `power` (DP 151) and the three mode-control
 * verbs (`startCleaning`, `returnToDock`, `pauseCleaning`, all DP 152 `ModeCtrlRequest`). DP 151 and
 * DP 152 belong to the shared AIoT product schema rather than to a device's reported param set, so
 * gating them on a reported DP would hide them on real hardware. No legacy Tuya clean-line write is
 * dispatched at all — that direction has no live `publishDps` capture behind it.
 *
 * Each AIoT mode-control verb carries its own `seq` counter per bind (the T2351 accepts per-closure
 * counters — two separately-obtained action objects both starting at 112 do not cause the device to
 * complain, so the seq is not enforced as globally monotonic).
 *
 * DP-gated READS: `doNotDisturb` (DP 107, Bool ro) and `rssi` (DP 134, WiFi signal strength) are
 * installed only when the device has reported those DPs. The `locate` action (DP 160) is owned by the
 * `locate` capability module.
 *
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const VACUUM_CLEAN_MEMBERS = {
  /**
   * The robot's power switch, and NOT a way to start a job — `startCleaning` is that.
   * DP 151 belongs to the shared AIoT product DP schema every clean-line device speaks, so the write
   * is gated on the confirmed AIoT platform (category-based via `isAiotVacuum`) rather than on a
   * reported DP — no equivalent power DP is confirmed on the legacy Tuya clean line.
   */
  power: {
    param: VACUUM_DP.POWER,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Power on/off (DP 151 power switch, cloud get_product_data_point).",
    write: (v, _ctx) => aiotDp(VACUUM_DP.POWER, asBool(v)),
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
  },
  /** Stored as the raw structured payload; the activity is decoded out of it at read time. */
  activity: {
    param: VACUUM_DP.WORK_STATUS,
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeVacuumActivity(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: VACUUM_ACTIVITIES,
    description:
      "High-level activity from WorkStatus (DP 153 work status, Raw protobuf). Reads the state field, " +
      "then the sub-messages that separate cleaning from paused and from a mop cycle on the dock.",
  },
  /**
   * The robot's own speaker loudness — its spoken prompts and chimes, nothing to do with suction noise.
   * Confirmed writable via `get_product_data_point` (`writable: true`); no live publishDps capture yet.
   * Reaches the getters only via `decodeState`, since the robot's cloud record carries no DPs at all.
   */
  volume: {
    param: VACUUM_DP.VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Speaker volume 0-100 (DP 161, Value ro). AIoT clean line.",
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
  },
  /**
   * Charge percentage — DP 163 for the AIoT clean line; DP 104 for the legacy Tuya (G-series/X8)
   * via a `readAliases` entry gated on {@link isTuyaVacuum}. Deliberately NOT the security param 1101
   * the `battery` capability reads, so a robot's charge is here rather than on `dev.battery()`.
   * Read-only, populated only once a realtime report lands.
   */
  battery: {
    param: VACUUM_DP.BATTERY,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    readAliases: [{ paramType: LEGACY_VACUUM_DP.BATTERY_LEVEL, available: isTuyaVacuum }],
    description: "Battery level 0-100 (DP 163 AIoT / DP 104 Tuya). NOTE: clean namespace — not param 1101.",
  },
  /**
   * Device UI language — the locale the robot uses for its voice prompts (DP 162, String rw).
   * AIoT clean line only; the Tuya X8 Pro has no confirmed language DP in its 1–134 schema.
   * Write direction confirmed from `get_product_data_point` (`writable: true`); locale format is
   * an open string (no live report observed for a closed set of values yet).
   */
  language: {
    param: VACUUM_DP.LANGUAGE,
    type: "string",
    kind: "text",
    provenance: "mega",
    description: "Device UI language locale code (DP 162, String ro). AIoT clean line.",
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
  },
  /**
   * The SETTING for what to do with a surface, not what a running job is doing — the two disagree while
   * a change is being applied. Stored as the raw structured payload (`type: "string"`), with the field
   * lifted out by `decode`: the injected codec turns the DP into a field tree and this capability names
   * which field means what, which is why the transport never has to know DP 154. The decode's own
   * return type wins on the surface, so the getter answers the named `VacuumCleanType` union.
   * For Tuya devices, DP 113 (Enum: "Sweep"|"SweepMop"|"Mop") is read via a `readAliases` entry.
   */
  cleanType: {
    param: VACUUM_DP.CLEAN_PARAM,
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeCleanType(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: [...VACUUM_CLEAN_TYPES, ...TUYA_CLEAN_TYPES] as readonly string[],
    readAliases: [{ paramType: TUYA_VACUUM_DP.CLEAN_TYPE, available: isTuyaVacuum }],
    description: "Configured cleaning type from CleanParam.clean_type (DP 154 AIoT protobuf) or DP 113 Tuya Enum.",
  },
  /**
   * What the robot does when it meets a carpet — raise the mop, drive around, or carry on over it.
   *
   * Reads its sibling's DP 154 payload: `clean_carpet` sits beside `clean_type` in the one `CleanParam`
   * the device reports, so there is one param and several readings of it.
   */
  carpetStrategy: {
    readsFrom: "cleanType",
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => {
      const v = decodeCleanParamValue(raw as ParamValue | undefined, codec, CLEAN_PARAM_FIELD.CLEAN_CARPET);
      return v === undefined ? undefined : CARPET_STRATEGY[v];
    },
    decodedKind: "enum",
    decodedValues: CARPET_STRATEGIES as readonly string[],
    description: "Carpet strategy from CleanParam.clean_carpet (DP 154 AIoT, Raw protobuf).",
  },
  /**
   * How far past the mapped edge a job reaches.
   *
   * The index order is the WIRE's, not the app's display order — a host that shows the raw number will
   * disagree with the phone. Surface the name.
   */
  cleanExtent: {
    readsFrom: "cleanType",
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => {
      const v = decodeCleanParamValue(raw as ParamValue | undefined, codec, CLEAN_PARAM_FIELD.CLEAN_EXTENT);
      return v === undefined ? undefined : CLEAN_EXTENT[v];
    },
    decodedKind: "enum",
    decodedValues: CLEAN_EXTENTS as readonly string[],
    description: "Clean extent from CleanParam.clean_extent (DP 154 AIoT, Raw protobuf). Wire order, not app order.",
  },
  /**
   * Whether the robot is left to its own judgement about a room — suction and water chosen per surface
   * rather than held at what the user set.
   */
  smartMode: {
    readsFrom: "cleanType",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => {
      const v = decodeCleanParamValue(raw as ParamValue | undefined, codec, CLEAN_PARAM_FIELD.SMART_MODE);
      return v === undefined ? undefined : v !== 0;
    },
    decodedKind: "boolean",
    description: "Smart mode from CleanParam.smart_mode_sw (DP 154 AIoT, Raw protobuf).",
  },
  /**
   * How many passes one job makes over the same floor. `0` is the device stating no repeat rather than
   * a robot that will not clean.
   */
  cleanTimes: {
    readsFrom: "cleanType",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) => decodeCleanParamValue(raw as ParamValue | undefined, codec, CLEAN_PARAM_FIELD.CLEAN_TIMES),
    decodedKind: "scalar",
    description: "Passes per job from CleanParam.clean_times (DP 154 AIoT, Raw protobuf).",
  },
  /**
   * The robot's current fault, as a numeric code. `0` is no fault; `undefined` is a device that has not
   * said, which is not the same thing.
   *
   * One number for both clean lines: the AIoT line reports an `ErrorCode` message on DP 177 carrying a
   * list of faults and a list of warnings, and the legacy Tuya line reports a plain integer on DP 106.
   * {@link decodeVacuumFault} answers the first fault, or the first warning when there is no fault.
   *
   * The code's MEANING is the vendor's own table and is not interpreted here — a host that wants text
   * maps the number itself.
   *
   * The DP 106 alias is DELIBERATELY ungated, unlike `battery` and `cleanType` which gate their
   * legacy aliases on `isTuyaVacuum`. A fault is the one reading worth surfacing even when the
   * family classification is wrong or absent, and {@link decodeVacuumFault} discriminates on the
   * value's SHAPE rather than on the family — so a device carrying DP 106 decodes sanely whichever
   * line it turns out to be on. The asymmetry is the point, not an oversight.
   */
  errorCode: {
    param: VACUUM_DP.FAULT_ALERT,
    type: "number",
    provenance: "mega",
    readAliases: [{ paramType: LEGACY_VACUUM_DP.ERROR_CODE }],
    decode: (raw, codec) => decodeVacuumFault(raw as ParamValue | undefined, codec),
    decodedKind: "scalar",
    description:
      "Current fault code, 0 = none. ErrorCode.error[0] (DP 177 faultAlert, Raw protobuf) falling " +
      "back to ErrorCode.warn[0], or the plain DP 106 integer on the legacy Tuya clean line.",
  },
  /**
   * High-level activity for the X8 Pro Tuya clean line (DP 15, Enum string). Decoded from the device's
   * `status` string to a {@link VacuumActivity} via `decodeTuyaWorkStatus`. Live-confirmed "Sleeping"
   * at rest. `"unknown"` covers any value absent from the schema-confirmed set.
   *
   * Distinct from {@link activity} (DP 153, protobuf), which the AIoT T2351 reports instead.
   */
  workStatus: {
    param: TUYA_VACUUM_DP.WORK_STATUS,
    type: "string",
    provenance: "mega",
    decode: (raw) => decodeTuyaWorkStatus(raw as ParamValue | undefined),
    decodedKind: "enum",
    decodedValues: VACUUM_ACTIVITIES,
    description: "High-level activity from DP 15 (status, Enum). X8 Pro Tuya clean line. Live-confirmed Sleeping.",
  },
  /**
   * Cleaning mode (DP 5, Enum string). Live-confirmed "auto". Distinct from the AIoT suction/mode
   * controls. Write direction is unverified — no live publishDps capture.
   *
   * Known values from schemaInfo.schema: `TUYA_WORK_MODES`.
   */
  workMode: {
    param: TUYA_VACUUM_DP.MODE,
    type: "string",
    provenance: "mega",
    decode: (raw): TuyaWorkMode | undefined => {
      const s = typeof raw === "string" ? raw : undefined;
      return s !== undefined && (TUYA_WORK_MODES as readonly string[]).includes(s) ? (s as TuyaWorkMode) : undefined;
    },
    decodedKind: "enum",
    decodedValues: TUYA_WORK_MODES,
    description: "Cleaning mode from DP 5 (mode, Enum). X8 Pro Tuya clean line. Live-confirmed auto. Write unverified.",
  },
  /**
   * Suction / cleaning strength (DP 102, Enum string). Live-confirmed "Off" at rest.
   * Write direction is unverified — no live publishDps capture.
   *
   * Known values from schemaInfo.schema: `TUYA_CLEANING_STRENGTHS`.
   */
  cleaningStrength: {
    param: TUYA_VACUUM_DP.CLEANING_STRENGTH,
    type: "string",
    provenance: "mega",
    decode: (raw): TuyaCleaningStrength | undefined => {
      const s = typeof raw === "string" ? raw : undefined;
      return s !== undefined && (TUYA_CLEANING_STRENGTHS as readonly string[]).includes(s)
        ? (s as TuyaCleaningStrength)
        : undefined;
    },
    decodedKind: "enum",
    decodedValues: TUYA_CLEANING_STRENGTHS,
    description:
      "Suction/cleaning strength from DP 102 (cleaning_strength, Enum). X8 Pro Tuya clean line. Live-confirmed Off. Write unverified.",
  },
  /**
   * Mop water flow level (DP 105, Enum string). Live-confirmed "Mid" at rest.
   * Write direction is unverified — no live publishDps capture.
   *
   * Known values from schemaInfo.schema: `TUYA_MOP_WATER_LEVELS`.
   */
  mopWater: {
    param: TUYA_VACUUM_DP.MOP_WATER,
    type: "string",
    provenance: "mega",
    decode: (raw): TuyaMopWaterLevel | undefined => {
      const s = typeof raw === "string" ? raw : undefined;
      return s !== undefined && (TUYA_MOP_WATER_LEVELS as readonly string[]).includes(s)
        ? (s as TuyaMopWaterLevel)
        : undefined;
    },
    decodedKind: "enum",
    decodedValues: TUYA_MOP_WATER_LEVELS,
    description:
      "Mop water flow level from DP 105 (MopWater, Enum). X8 Pro Tuya clean line. Live-confirmed Mid. Write unverified.",
  },
  /**
   * Session cleaning duration in seconds (DP 109, Value). Live-confirmed 4200 (= 70 min) at rest.
   * Read-only — no write is expected for a session counter.
   */
  clearTime: {
    param: VACUUM_DP.CLEAN_STATS,
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "mega",
    readAliases: [{ paramType: TUYA_VACUUM_DP.CLEAR_TIME, available: isTuyaVacuum }],
    decode: (raw, codec) =>
      decodeCleanStat(raw as ParamValue | undefined, codec, CLEAN_STATS_FIELD.SINGLE, CLEAN_STATS_FIELD.DURATION),
    decodedKind: "seconds",
    description:
      "Session cleaning duration in seconds — CleanStatistics.single.clean_duration (DP 167 AIoT, Raw " +
      "protobuf) or the plain DP 109 integer on the Tuya clean line.",
  },
  /**
   * Session cleaned area in m² (DP 110, Value). Live-confirmed 54 at rest. Read-only.
   */
  clearArea: {
    param: TUYA_VACUUM_DP.CLEAR_AREA,
    readsFrom: "clearTime",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeCleanStat(raw as ParamValue | undefined, codec, CLEAN_STATS_FIELD.SINGLE, CLEAN_STATS_FIELD.AREA),
    decodedKind: "scalar",
    description:
      "Session cleaned area in m² — the plain DP 110 integer on the Tuya clean line, or " +
      "CleanStatistics.single.clean_area (DP 167 AIoT, Raw protobuf).",
  },
  /**
   * Speaker loudness 0-100 (DP 111, Value). Live-confirmed 38.
   * Distinct from {@link volume} (DP 161), which the AIoT T2351 reports.
   */
  loudness: {
    param: TUYA_VACUUM_DP.LOUDNESS,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Speaker loudness 0-100 from DP 111 (Loudness). X8 Pro Tuya clean line. Live-confirmed.",
  },
  /**
   * Lifetime total cleaning time in seconds (DP 119, Value). Counts across all sessions.
   * Confirmed from `thing.m.device.ref.info.list` v5.4 schemaInfo.schema (X8 Pro,
   * product `wahqax6ifjgs1c4n`). Read-only accumulator — no write expected.
   */
  lifetimeCleanTime: {
    param: TUYA_VACUUM_DP.CLEAR_TOTAL_TIME,
    readsFrom: "clearTime",
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeCleanStat(raw as ParamValue | undefined, codec, CLEAN_STATS_FIELD.USER_TOTAL, CLEAN_STATS_FIELD.DURATION),
    decodedKind: "seconds",
    description:
      "Lifetime cleaning time in seconds — the plain DP 119 integer on the Tuya clean line, or " +
      "CleanStatistics.user_total.clean_duration (DP 167 AIoT, Raw protobuf).",
  },
  /**
   * Lifetime total cleaned area in m² (DP 120, Value). Counts across all sessions.
   * Confirmed from `thing.m.device.ref.info.list` v5.4 schemaInfo.schema (X8 Pro,
   * product `wahqax6ifjgs1c4n`). Read-only accumulator — no write expected.
   */
  lifetimeCleanArea: {
    param: TUYA_VACUUM_DP.CLEAR_TOTAL_AREA,
    readsFrom: "clearTime",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeCleanStat(raw as ParamValue | undefined, codec, CLEAN_STATS_FIELD.USER_TOTAL, CLEAN_STATS_FIELD.AREA),
    decodedKind: "scalar",
    description:
      "Lifetime cleaned area in m² — the plain DP 120 integer on the Tuya clean line, or " +
      "CleanStatistics.user_total.clean_area (DP 167 AIoT, Raw protobuf).",
  },
  /**
   * How many runs the robot has completed in its lifetime.
   *
   * AIoT only — it rides inside the same `CleanStatistics` the two figures above read, and the Tuya
   * clean line has no DP for it. So this one borrows without a wire of its own, where its siblings keep
   * theirs and only fall back to the payload.
   */
  lifetimeCleanCount: {
    readsFrom: "clearTime",
    type: "number",
    kind: "scalar",
    provenance: "mega",
    // Refuses a bare number outright. Its owner also answers from a Tuya DP via a read alias, and that
    // DP carries a session DURATION — passing it through would report seconds as a run count. A member
    // with no wire of its own can only be answered by the protobuf, so anything else is `undefined`.
    decode: (raw, codec) =>
      typeof raw === "string" && !/^\d+$/.test(raw)
        ? decodeCleanStat(raw, codec, CLEAN_STATS_FIELD.USER_TOTAL, CLEAN_STATS_FIELD.COUNT)
        : undefined,
    decodedKind: "scalar",
    description: "Completed runs in the robot's lifetime — CleanStatistics.user_total.clean_count (DP 167 AIoT).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.CLEAN_STATS) ?? false,
  },
  /**
   * Water tank attached (DP 127, Bool ro). Confirmed from `thing.m.device.ref.info.list` v5.4.
   * `true` when the water tank is mounted; `false` when removed. Read-only sensor — the device
   * reports this, the app does not write it.
   */
  waterTank: {
    param: TUYA_VACUUM_DP.WATER_TANK_STATUS,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Water tank attached (DP 127, Bool ro). X8 Pro Tuya clean line. Schema-confirmed.",
  },
  /**
   * Mop pad attached (DP 129, Bool ro). Confirmed from `thing.m.device.ref.info.list` v5.4.
   * `true` when the mop pad is mounted; `false` when removed. Read-only sensor.
   */
  mopPad: {
    param: TUYA_VACUUM_DP.MOP_STATUS,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Mop pad attached (DP 129, Bool ro). X8 Pro Tuya clean line. Schema-confirmed.",
  },
  /**
   * Child lock — when on, the robot ignores its physical buttons.
   *
   * AIoT clean line only; no equivalent is confirmed on the Tuya schema, so there is no read alias.
   */
  childLock: {
    param: VACUUM_DP.SETTINGS,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.CHILDREN_LOCK),
    decodedKind: "boolean",
    description: "Child lock from UnisettingResponse.children_lock (DP 176 commonSettings, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.SETTINGS) ?? false,
  },
  /**
   * Whether a cruise resumes by itself after the robot has charged, rather than ending at the dock.
   */
  cruiseContinue: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.CRUISE_CONTINUE),
    decodedKind: "boolean",
    description: "Resume a cruise after charging — UnisettingResponse.cruise_continue_sw (DP 176, Raw protobuf).",
  },
  /**
   * Whether the robot keeps more than one saved map — a house with more than one floor needs this on.
   */
  multiMap: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.MULTI_MAP),
    decodedKind: "boolean",
    description: "Multi-map storage — UnisettingResponse.multi_map_sw (DP 176, Raw protobuf).",
  },
  /**
   * The obstacle-recognition camera. Off means the robot navigates without it, not that it is broken.
   */
  aiSee: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.AI_SEE),
    decodedKind: "boolean",
    description: "Obstacle-recognition camera — UnisettingResponse.ai_see (DP 176, Raw protobuf).",
  },
  /**
   * The vendor's `water_level_sw`. Named after the wire rather than given a friendlier name: what it\n   * switches is not stated anywhere this SDK can point at, and a guessed name would be a claim.
   */
  waterLevelSwitch: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.WATER_LEVEL),
    decodedKind: "boolean",
    description:
      "UnisettingResponse.water_level_sw (DP 176, Raw protobuf). Vendor name kept — its meaning is unconfirmed.",
  },
  /**
   * Whether the robot offers restricted-area suggestions after a run — the prompts that ask to fence\n   * off a spot it got stuck in.
   */
  suggestRestricted: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.SUGGEST_RESTRICTED),
    decodedKind: "boolean",
    description: "Restricted-area suggestions — UnisettingResponse.suggest_restricted (DP 176, Raw protobuf).",
  },
  /**
   * Extra corner passes while mopping. Slower runs, cleaner corners.
   */
  deepMopCorner: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.DEEP_MOP_CORNER),
    decodedKind: "boolean",
    description: "Deep corner mopping — UnisettingResponse.deep_mop_corner_sw (DP 176, Raw protobuf).",
  },
  /**
   * Whether the robot warns when its dust bag is full.
   */
  dustFullRemind: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.DUST_FULL_REMIND),
    decodedKind: "boolean",
    description: "Dust-bag-full reminder — UnisettingResponse.dust_full_remind (DP 176, Raw protobuf).",
  },
  /**
   * Whether the robot captures stills while cleaning.
   */
  livePhoto: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.LIVE_PHOTO),
    decodedKind: "boolean",
    description: "Capture stills while cleaning — UnisettingResponse.live_photo_sw (DP 176, Raw protobuf).",
  },
  /**
   * Smart-follow mode. Numbered 13 in the response and 12 in the request — the widest gap in a message\n   * whose two directions disagree about almost every field.
   */
  smartFollow: {
    readsFrom: "childLock",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeUnisetting(raw as ParamValue | undefined, codec, UNISETTING_FIELD.SMART_FOLLOW),
    decodedKind: "boolean",
    description: "Smart-follow mode — UnisettingResponse.smart_follow_sw (DP 176, Raw protobuf).",
  },
  /**
   * Hours run on the current side brush.\n   *\n   * The owner of DP 168 — the other eight counters read their own field out of this same payload, which\n   * is why they declare `readsFrom` rather than a wire of their own. Hours USED, counting up: the\n   * vendor sends no life expectancy, so a percentage remaining is the host's calibration to make, not\n   * a number this SDK can invent.
   */
  sideBrushHours: {
    param: VACUUM_DP.CONSUMABLES,
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.SIDE_BRUSH),
    decodedKind: "hours",
    description: "Side-brush hours used — ConsumableRuntime.side_brush (DP 168 consumables, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.CONSUMABLES) ?? false,
  },
  /**
   * Hours run on the current rolling brush.
   */
  rollingBrushHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.ROLLING_BRUSH),
    decodedKind: "hours",
    description: "Rolling-brush hours used — ConsumableRuntime.rolling_brush (DP 168, Raw protobuf).",
  },
  /**
   * Hours run on the current filter mesh.
   */
  filterHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.FILTER_MESH),
    decodedKind: "hours",
    description: "Filter-mesh hours used — ConsumableRuntime.filter_mesh (DP 168, Raw protobuf).",
  },
  /**
   * Hours run on the current scraper.
   */
  scraperHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.SCRAPE),
    decodedKind: "hours",
    description: "Scraper hours used — ConsumableRuntime.scrape (DP 168, Raw protobuf).",
  },
  /**
   * Hours since the sensors were last cleaned.
   */
  sensorHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.SENSOR),
    decodedKind: "hours",
    description: "Hours since the sensors were cleaned — ConsumableRuntime.sensor (DP 168, Raw protobuf).",
  },
  /**
   * Hours run on the current mop pad.
   */
  mopHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.MOP),
    decodedKind: "hours",
    description: "Mop-pad hours used — ConsumableRuntime.mop (DP 168, Raw protobuf).",
  },
  /**
   * Hours since the dust bag was last changed.
   */
  dustBagHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) => decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.DUSTBAG),
    decodedKind: "hours",
    description: "Dust-bag hours used — ConsumableRuntime.dustbag (DP 168, Raw protobuf).",
  },
  /**
   * Hours since the waste-water tank was last emptied. Field 10, not 8 — the vendor leaves 8 and 9\n   * unused and closing that gap would read the wrong counter.
   */
  dirtyWaterTankHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.DIRTY_WATERTANK),
    decodedKind: "hours",
    description: "Waste-water-tank hours — ConsumableRuntime.dirty_watertank (DP 168, Raw protobuf).",
  },
  /**
   * Hours run on the waste-water filter.
   */
  dirtyWaterFilterHours: {
    readsFrom: "sideBrushHours",
    type: "number",
    unit: "h",
    kind: "hours",
    provenance: "mega",
    decode: (raw, codec) =>
      decodeConsumableHours(raw as ParamValue | undefined, codec, CONSUMABLE_FIELD.DIRTY_WATERFILTER),
    decodedKind: "hours",
    description: "Waste-water-filter hours — ConsumableRuntime.dirty_waterfilter (DP 168, Raw protobuf).",
  },
  /**
   * Do-not-disturb — when on, the robot suppresses its voice announcements.
   *
   * Reports whether the feature is SWITCHED ON, not whether the quiet window happens to be open right
   * now; `UndisturbedResponse` carries that as a separate `active` flag which this deliberately skips.
   */
  doNotDisturb: {
    param: VACUUM_DP.DO_NOT_DISTURB,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    readAliases: [{ paramType: TUYA_VACUUM_DP.FORBID_MODE, available: isTuyaVacuum }],
    decode: (raw, codec) => decodeDoNotDisturb(raw as ParamValue | undefined, codec),
    decodedKind: "boolean",
    description:
      "Do-not-disturb switch — Undisturbed.sw (DP 157 AIoT, Raw protobuf) or the plain DP 107 bool on " +
      "the Tuya clean line. Whether the feature is ON, not whether the window is open right now.",
    available: (ctx: AvailabilityContext) =>
      (ctx.paramIds?.has(VACUUM_DP.DO_NOT_DISTURB) ?? false) ||
      (ctx.paramIds?.has(TUYA_VACUUM_DP.FORBID_MODE) ?? false),
  },
  /**
   * Whether the do-not-disturb window is open RIGHT NOW — the live flag, not the switch beside it.
   *
   * A caller showing "quiet hours" as a schedule wants `doNotDisturb`; one
   * asking why the robot just declined to speak wants this. The two disagree for most of the day.
   *
   * Reads its sibling's payload rather than a wire of its own: `active` and `sw` are two fields of the
   * one `UndisturbedResponse` the device reports on DP 157, so there is one param and two readings of
   * it. AIoT only — the Tuya line's DP 107 carries the switch and says nothing about the window.
   */
  doNotDisturbActive: {
    readsFrom: "doNotDisturb",
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    decode: (raw, codec) => decodeDoNotDisturbActive(raw as ParamValue | undefined, codec),
    decodedKind: "boolean",
    description: "Whether the do-not-disturb window is open now — Undisturbed.active (DP 157 AIoT, Raw protobuf).",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(VACUUM_DP.DO_NOT_DISTURB) ?? false,
  },
  /**
   * WiFi RSSI in dBm (DP 134, Value ro). Schema-confirmed from `thing.m.device.ref.info.list` v5.4.
   * Negative integer; closer to zero is stronger. Useful for diagnostics.
   */
  rssi: {
    param: TUYA_VACUUM_DP.RSSI,
    type: "number",
    unit: "dBm",
    kind: "dbm",
    provenance: "mega",
    description: "WiFi RSSI in dBm (DP 134, Value ro). Schema-confirmed.",
    available: (ctx: AvailabilityContext) => ctx.paramIds?.has(TUYA_VACUUM_DP.RSSI) ?? false,
  },
  /** Start an auto-clean run via ModeCtrlRequest method 0 (DP 152). AIoT only — Tuya write unverified. */
  startCleaning: method(
    ({ sink }) => {
      let seq = 111;
      return (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_AUTO_CLEAN, ++seq)));
    },
    "Start an auto-clean run (ModeCtrlRequest method 0 over DP 152).",
    isAiotVacuum,
  ),
  /** Return to the dock via ModeCtrlRequest method 6 (DP 152). AIoT only — Tuya write unverified. */
  returnToDock: method(
    ({ sink }) => {
      let seq = 111;
      return (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_GOHOME, ++seq)));
    },
    "Return to the dock (ModeCtrlRequest method 6 over DP 152).",
    isAiotVacuum,
  ),
  /** Pause the current cleaning task via ModeCtrlRequest method 13 (DP 152). AIoT only — Tuya write unverified. */
  pauseCleaning: method(
    ({ sink }) => {
      let seq = 111;
      return (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.PAUSE_TASK, ++seq)));
    },
    "Pause the current cleaning task (ModeCtrlRequest method 13 over DP 152).",
    isAiotVacuum,
  ),
} as const satisfies Members;

/** `vacuum_clean` — core RoboVac scalar state + decoded activity: power, activity, volume, battery. */
export const VACUUM_CLEAN: CapabilityModule = {
  capability: "vacuum_clean",
  line: "clean",
  description: "RoboVac core state: power, activity (WorkStatus), volume and battery (Tuya DP).",
  members: VACUUM_CLEAN_MEMBERS,
  properties: propertiesOf(VACUUM_CLEAN_MEMBERS),
  /** Core RoboVac control is the vacuum-codec baseline. */
  detection: { codecs: ["vacuum"] },
  /**
   * Land this capability's data points from a realtime report. The robot's cloud record does NOT carry
   * them — it reports state only over its realtime feed — so without this the evidence gate sees no
   * backing param and installs no getter at all. Values are stored as sent; `activity` stays the raw
   * structured payload until {@link decodeVacuumActivity} unpacks it at read time.
   */
  decodeState(signal) {
    const params = pickDpParams(signal.source === "mqtt" ? signal.dpParams : undefined, [
      ...Object.values(VACUUM_DP),
      ...Object.values(LEGACY_VACUUM_DP),
      ...Object.values(TUYA_VACUUM_DP),
    ]);
    return params ? { params } : null;
  },
};
