import type { RawDpCodec } from "../../core/contracts.js";
import type { ParamValue } from "../types.js";
import type { CapabilityModule } from "./types.js";
import { asBool } from "../../core/util.js";
import { pickDpParams, aiotDp } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import { isAiotVacuum } from "../device-family.js";

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
  /** Battery level 0-100 (DP 163, Value) — a clean-namespace DP, NOT the security param 1101. */
  BATTERY: 163,
} as const;

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
 * status the SDK can't classify yet. Several finer states collapse into `"cleaning"` today.
 */
export type VacuumActivity = (typeof VACUUM_ACTIVITIES)[number];

/**
 * `WorkStatus.state` (protobuf field #2) → {@link VacuumActivity}.
 *
 * Only three values are **live-verified** on a T2351 — a start→return→charge run reported `5`(cleaning)
 * → `7`(returning) → `3`(docked), matching the physical actions. Every other value is carried from the
 * legacy `eufy-clean` `control.proto` enum and is **UNVERIFIED** (flagged inline, the same way the
 * arming module marks its unconfirmed mode ids); each is best-effort until captured on-device.
 *
 * Known gap — `state == 5` is not final; it carries a sub-state this decoder does not read (it only
 * reads field #2). The reversed `WorkStatus` shows the same `5` also means **paused**
 * (`cleaning.state == 1`) or **parked at the dock running its wash/dry cycle** (`go_wash.mode ∈ {1,2}`
 * / `station` washing-drying), not just actively cleaning. So a paused robot AND one washing/drying on
 * the dock both currently read as `"cleaning"`, and the standalone `15` (paused) value may be
 * unreachable in practice. Resolving it needs those sub-fields decoded; they are not guessed here.
 */
const WORK_STATE_ACTIVITY: Record<number, VacuumActivity> = {
  0: "idle", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  1: "idle", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  2: "error", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  3: "docked", // ✅ live T2351
  4: "cleaning", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  5: "cleaning", // ✅ live T2351
  6: "cleaning", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  7: "returning", // ✅ live T2351
  8: "cleaning", // ⚠️ unverified — legacy eufy-clean enum, see doc above
  15: "paused", // ⚠️ unverified — legacy eufy-clean enum; may be unreachable, see "Known gap" above
};

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
  /** `value` within a `CleanType`. */
  VALUE: 1,
} as const;

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
): VacuumCleanType | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const configured = codec.decode(raw)?.find((f) => f.field === CLEAN_PARAM_FIELD.CONFIGURED);
  if (configured?.kind !== "bytes" || !configured.value.length) return undefined;
  const cleanType = codec.nested(configured.value)?.find((f) => f.field === CLEAN_PARAM_FIELD.CLEAN_TYPE);
  if (cleanType?.kind !== "bytes") return undefined;
  if (!cleanType.value.length) return CLEAN_TYPE[0];
  const value = codec.nested(cleanType.value)?.find((f) => f.field === CLEAN_PARAM_FIELD.VALUE);
  if (!value) return CLEAN_TYPE[0];
  return value.kind === "int" ? CLEAN_TYPE[Number(value.value)] : undefined;
}

/** `state`'s field number inside the `WorkStatus` message — the one field of DP 153 read today. */
const WORK_STATUS_STATE_FIELD = 2;

/**
 * Decode a `WorkStatus` (DP 153) Raw-DP value to a {@link VacuumActivity}. That DP carries a whole
 * protobuf message rather than a scalar, so the payload is read through the injected {@link RawDpCodec}:
 * the codec owns the structure, this owns which field number carries which meaning. `"unknown"` covers
 * every way the answer can be absent — an unbound device (no codec), a malformed payload, no field
 * {@link WORK_STATUS_STATE_FIELD}, or a state value missing from {@link WORK_STATE_ACTIVITY}.
 * @internal
 */
export function decodeVacuumActivity(raw: ParamValue | undefined, codec: RawDpCodec | undefined): VacuumActivity {
  if (typeof raw !== "string" || !codec) return "unknown";
  const state = codec.decode(raw)?.find((f) => f.field === WORK_STATUS_STATE_FIELD);
  if (state?.kind !== "int") return "unknown";
  return WORK_STATE_ACTIVITY[Number(state.value)] ?? "unknown";
}

/**
 * Bound RoboVac reads and controls — the object returned by `dev.vacuumClean()`.
 *
 * All reads, `setPower`, and the three mode-control verbs are DERIVED from `VACUUM_CLEAN_MEMBERS`.
 * Each getter is present only when the device reports the backing DP. `setPower` and the mode-control
 * verbs are optional — they are absent on any device whose `category` is not a confirmed AIoT string
 * (see `isAiotVacuum` in `device-family.ts`).
 */
export type VacuumCleanActions = Surface<typeof VACUUM_CLEAN_MEMBERS>;

/**
 * Every `vacuum_clean` read plus the writes and mode-control verbs.
 *
 * `power` (DP 151) is part of the shared AIoT product DP schema for every T2xxx clean-line device — not
 * a model-specific extension — so its write is offered on any bound robot rather than gated on a
 * reported DP. `power` and the three mode-control verbs (`startCleaning`, `returnToDock`,
 * `pauseCleaning`) are all gated by `available: isAiotVacuum` so they are absent on any device whose
 * `category` is not a confirmed AIoT string. Each mode-control verb carries its own `seq` counter per
 * bind (the T2351 accepts per-closure counters — two separately-obtained action objects both starting
 * at 112 do not cause the device to complain, so the seq is not enforced as globally monotonic).
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
   * is gated on the confirmed AIoT platform (`available: isAiotVacuum`) rather than on a reported DP.
   */
  power: {
    param: VACUUM_DP.POWER,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    description: "Power on/off (DP 151 power switch, cloud get_product_data_point).",
    write: (v, _ctx) => aiotDp(VACUUM_DP.POWER, asBool(v)),
    available: (ctx) => isAiotVacuum(ctx),
  },
  /** Stored as the raw structured payload; the activity is decoded out of it at read time. */
  activity: {
    param: VACUUM_DP.WORK_STATUS,
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeVacuumActivity(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: VACUUM_ACTIVITIES,
    description: "High-level activity from WorkStatus.state (DP 153 work status, Raw protobuf).",
  },
  /**
   * The robot's own speaker loudness — its spoken prompts and chimes, nothing to do with suction noise.
   * Read-only: DP 161 is confirmed as a reported value but no write has been captured for it. Reaches
   * the getters only via `decodeState`, since the robot's cloud record carries no DPs at all.
   */
  volume: {
    param: VACUUM_DP.VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Speaker volume 0-100 (DP 161, Value).",
  },
  /**
   * Charge percentage on the clean-line DP 163 — deliberately NOT the security param 1101 the `battery`
   * capability reads, so a robot's charge is here rather than on `dev.battery()`. Read-only, and
   * populated only once a realtime report lands, since the cloud record carries no DPs.
   */
  battery: {
    param: VACUUM_DP.BATTERY,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    description: "Battery level 0-100 (DP 163). NOTE: clean namespace — not param 1101.",
  },
  /**
   * The SETTING for what to do with a surface, not what a running job is doing — the two disagree while
   * a change is being applied. Stored as the raw structured payload (`type: "string"`), with the field
   * lifted out by `decode`: the injected codec turns the DP into a field tree and this capability names
   * which field means what, which is why the transport never has to know DP 154. The decode's own
   * return type wins on the surface, so the getter answers the named `VacuumCleanType` union.
   */
  cleanType: {
    param: VACUUM_DP.CLEAN_PARAM,
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeCleanType(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: VACUUM_CLEAN_TYPES,
    description: "Configured cleaning type from CleanParam.clean_type (DP 154 clean params, Raw protobuf).",
  },
  /** Start an auto-clean run — ModeCtrlRequest method 0 over DP 152. */
  startCleaning: method(
    ({ sink }) => {
      let seq = 111;
      return (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_AUTO_CLEAN, ++seq)));
    },
    "Start an auto-clean run (ModeCtrlRequest method 0, DP 152).",
    isAiotVacuum,
  ),
  /** Send the robot back to its dock — ModeCtrlRequest method 6 over DP 152. */
  returnToDock: method(
    ({ sink }) => {
      let seq = 111;
      return (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.START_GOHOME, ++seq)));
    },
    "Return to the dock (ModeCtrlRequest method 6, DP 152).",
    isAiotVacuum,
  ),
  /** Pause the current cleaning task — ModeCtrlRequest method 13 over DP 152. */
  pauseCleaning: method(
    ({ sink }) => {
      let seq = 111;
      return (): Promise<void> =>
        sink.dispatch(aiotDp(VACUUM_DP.MODE_CTRL, encodeModeCtrl(ModeCtrlMethod.PAUSE_TASK, ++seq)));
    },
    "Pause the current cleaning task (ModeCtrlRequest method 13, DP 152).",
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
    const params = pickDpParams(signal.source === "mqtt" ? signal.dpParams : undefined, Object.values(VACUUM_DP));
    return params ? { params } : null;
  },
};
