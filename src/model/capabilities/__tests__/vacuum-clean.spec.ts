import type { RawDpCodec, RawDpField } from "../../../core/contracts.js";
import type { CommandContext } from "../types.js";
import {
  VACUUM_CLEAN,
  VACUUM_DP,
  LEGACY_VACUUM_DP,
  TUYA_VACUUM_DP,
  decodeVacuumActivity,
  decodeCleanType,
  decodeUnisetting,
  decodeCleanParamValue,
  decodeConsumableHours,
  decodeDoNotDisturb,
  decodeDoNotDisturbActive,
  decodeCleanStat,
  decodeVacuumFault,
  encodeModeCtrl,
  ModeCtrlMethod,
  type VacuumCleanActions,
  type VacuumActivity,
  type VacuumCleanType,
  type TuyaCleanType,
} from "../vacuum-clean.js";
import { bind } from "./bind.js";
import { byteCodec, frame, int, sub, varint } from "./proto-bytes.js";

/**
 * The capability is exercised against a FAKE codec, never the real `transport/raw-dp.ts` — importing
 * that here would break the decorrelation guard, which greps `src/model` with no `__tests__` exemption.
 * That constraint is the point: if this spec can decode a payload without transport in scope, so can
 * any other consumer of the contract.
 */
function fakeCodec(fields: readonly RawDpField[] | undefined): RawDpCodec {
  return { decode: () => fields, nested: () => fields };
}
/** A codec reporting only `WorkStatus.state` (field #2), as the real one would for a state-carrying frame. */
function workStatus(state: number): RawDpCodec {
  return fakeCodec([{ field: 2, kind: "int", value: BigInt(state) }]);
}

/**
 * `encodeModeCtrl` — hand-rolled proto3 varint encoder for `ModeCtrlRequest` (DP 152).
 * Tests are byte-exact: we decode the base64 output and compare the raw wire bytes, so a
 * regression silently producing a wrong frame (no-ops on the device) is caught here.
 *
 * Wire format: `varint(bodyLen) ++ body` where `body = {field#1:method, field#2:seq}`.
 * Method 0 (START_AUTO_CLEAN) is omitted per proto3 default — field#2 only.
 */
describe("encodeModeCtrl", () => {
  it("START_AUTO_CLEAN (method 0, seq 112) — field #1 omitted per proto3 default", () => {
    // body: [0x10, 0x70]  (field2 tag + varint 112)
    // wire: [0x02, 0x10, 0x70]
    expect(Buffer.from(encodeModeCtrl(ModeCtrlMethod.START_AUTO_CLEAN, 112), "base64")).toEqual(
      Buffer.from([0x02, 0x10, 0x70]),
    );
  });

  it("START_GOHOME (method 6, seq 112)", () => {
    // body: [0x08, 0x06, 0x10, 0x70]
    // wire: [0x04, 0x08, 0x06, 0x10, 0x70]
    expect(Buffer.from(encodeModeCtrl(ModeCtrlMethod.START_GOHOME, 112), "base64")).toEqual(
      Buffer.from([0x04, 0x08, 0x06, 0x10, 0x70]),
    );
  });

  it("PAUSE_TASK (method 13, seq 112)", () => {
    // body: [0x08, 0x0d, 0x10, 0x70]
    // wire: [0x04, 0x08, 0x0d, 0x10, 0x70]
    expect(Buffer.from(encodeModeCtrl(ModeCtrlMethod.PAUSE_TASK, 112), "base64")).toEqual(
      Buffer.from([0x04, 0x08, 0x0d, 0x10, 0x70]),
    );
  });

  it("encodes a multi-byte varint seq (seq 200 > 127)", () => {
    // seq 200: varint = [0xc8, 0x01]  (200 = 0b11001000 → [0xC8 with msb set, 0x01])
    // body (method 0): [0x10, 0xc8, 0x01] — field#1 still omitted for method 0
    // wire: [0x03, 0x10, 0xc8, 0x01]
    expect(Buffer.from(encodeModeCtrl(ModeCtrlMethod.START_AUTO_CLEAN, 200), "base64")).toEqual(
      Buffer.from([0x03, 0x10, 0xc8, 0x01]),
    );
  });
});

/** Minimal `CommandContext` for a given model/category and optional DP id set. */
function fakeCtx(model?: string, category?: string, paramIds: Set<number> = new Set()): CommandContext {
  return { channel: 0, codec: "vacuum", model, category, paramIds };
}

describe("vacuum_clean capability module", () => {
  it("declares the capability + schema", () => {
    expect(VACUUM_CLEAN.capability).toBe("vacuum_clean");
    expect(VACUUM_CLEAN.properties.map((p) => p.name)).toEqual([
      "power",
      "activity",
      "volume",
      "battery",
      "language",
      "cleanType",
      "errorCode",
      "workStatus",
      "workMode",
      "cleaningStrength",
      "mopWater",
      "clearTime",
      "clearArea",
      "loudness",
      "lifetimeCleanTime",
      "lifetimeCleanArea",
      "waterTank",
      "mopPad",
      "childLock",
      "sideBrushHours",
      "doNotDisturb",
      "rssi",
    ]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of VACUUM_CLEAN.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("is a vacuum-codec baseline", () => {
    expect(VACUUM_CLEAN.detection?.codecs).toEqual(["vacuum"]);
  });

  /**
   * `coerce` runs at ingest and would have no codec in scope; `decode` runs inside the getter, which is
   * the only place the injected `RawDpCodec` exists. The schema must therefore carry NO ingest decode.
   */
  it("decodes activity at read time, not at ingest — the codec only exists once bound", () => {
    expect(VACUUM_CLEAN.properties.find((p) => p.name === "activity")?.decode).toBeUndefined();
    const activity = VACUUM_CLEAN.members!.activity as { decode?: unknown; decodedValues?: readonly unknown[] };
    expect(activity.decode).toBeTypeOf("function");
    expect(activity.decodedValues).toContain("docked");
  });
});

describe("decodeVacuumActivity (WorkStatus.state → activity)", () => {
  it("maps the confirmed state enum", () => {
    expect(decodeVacuumActivity("payload", workStatus(0))).toBe("idle");
    expect(decodeVacuumActivity("payload", workStatus(1))).toBe("idle");
    expect(decodeVacuumActivity("payload", workStatus(2))).toBe("error");
    expect(decodeVacuumActivity("payload", workStatus(3))).toBe("docked");
    expect(decodeVacuumActivity("payload", workStatus(5))).toBe("cleaning");
    expect(decodeVacuumActivity("payload", workStatus(7))).toBe("returning");
  });

  it("has no state above the vendor enum's last member — 15 is not a state a device can report", () => {
    expect(decodeVacuumActivity("payload", workStatus(9))).toBe("unknown");
    expect(decodeVacuumActivity("payload", workStatus(15))).toBe("unknown");
  });

  it("picks field #2 out of a full frame, ignoring the fields around it", () => {
    const frame = fakeCodec([
      { field: 1, kind: "int", value: 12n },
      { field: 2, kind: "int", value: 3n },
      { field: 3, kind: "bytes", value: Buffer.from([0x1a, 0x00]) },
      { field: 14, kind: "bytes", value: Buffer.alloc(0) },
    ]);
    expect(decodeVacuumActivity("payload", frame)).toBe("docked");
  });

  it("returns 'unknown' for an unmapped state", () => {
    expect(decodeVacuumActivity("payload", workStatus(99))).toBe("unknown");
  });

  it("returns 'unknown' when the payload is undecodable or carries no state field", () => {
    expect(decodeVacuumActivity("payload", fakeCodec(undefined))).toBe("unknown");
    expect(decodeVacuumActivity("payload", fakeCodec([]))).toBe("unknown");
    expect(decodeVacuumActivity("payload", fakeCodec([{ field: 2, kind: "bytes", value: Buffer.alloc(1) }]))).toBe(
      "unknown",
    );
  });

  it("returns 'unknown' without a codec — an unbound device never guesses", () => {
    expect(decodeVacuumActivity("payload", undefined)).toBe("unknown");
  });

  it("returns 'unknown' for a non-string value", () => {
    expect(decodeVacuumActivity(undefined, workStatus(3))).toBe("unknown");
    expect(decodeVacuumActivity(7, workStatus(3))).toBe("unknown");
  });
});

/** `WorkStatus.state` = CLEANING(5), plus whichever sub-messages the fixture states. */
function cleaningFrame(...subs: number[][]): string {
  return frame([...int(2, 5), ...subs.flat()]);
}

/**
 * State 5 is the vendor's catch-all for "off the dock or servicing mops", and separating its members is
 * the whole point of reading the sub-messages. Each case here is a physical situation a T2351 reaches.
 */
describe("decodeVacuumActivity — WorkStatus state 5 sub-states", () => {
  it("is cleaning when no sub-message narrows it", () => {
    expect(decodeVacuumActivity(cleaningFrame(), byteCodec)).toBe("cleaning");
  });

  it("is paused when the cleaning job reports PAUSED", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(6, int(1, 1))), byteCodec)).toBe("paused");
  });

  it("is cleaning when the cleaning job is present but running — an empty sub-message means DOING", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(6, [])), byteCodec)).toBe("cleaning");
  });

  it("is docked while the dock washes or dries the mops", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(7, int(2, 1))), byteCodec)).toBe("docked");
    expect(decodeVacuumActivity(cleaningFrame(sub(7, int(2, 2))), byteCodec)).toBe("docked");
  });

  it("is still cleaning while DRIVING to the dock to wash — navigation is not arrival", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(7, [])), byteCodec)).toBe("cleaning");
  });

  it("is docked when the station reports a washing/drying cycle", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(14, sub(3, []))), byteCodec)).toBe("docked");
  });

  it("is cleaning when the station is reported but idle", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(14, [])), byteCodec)).toBe("cleaning");
  });

  it("prefers the dock over the pause — a robot that paused itself to go wash reports both", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(6, int(1, 1)), sub(7, int(2, 1))), byteCodec)).toBe("docked");
  });

  it("refines only state 5 — every other state answers from the state field alone", () => {
    expect(decodeVacuumActivity(frame([...int(2, 3), ...sub(6, int(1, 1))]), byteCodec)).toBe("docked");
    expect(decodeVacuumActivity(frame([...int(2, 7), ...sub(7, int(2, 2))]), byteCodec)).toBe("returning");
  });

  it("falls back to cleaning on a frame whose sub-messages it cannot read", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(6, [0xff])), byteCodec)).toBe("cleaning");
  });
});

/**
 * `CleanParam` (DP 154) → cleaning type. Fixtures are synthesized to the SHAPES a live T2351 emits: it
 * sends all four `CleanParamResponse` containers on every report, present-but-empty when unset, so the
 * decode has to lean on the presence of the fields inside rather than on the container.
 */
function cleanParam(fields: readonly RawDpField[]): RawDpCodec {
  return {
    decode: () => fields,
    nested: (v: Buffer) => (v.length ? [{ field: 1, kind: "int", value: BigInt(v[0]) }] : []),
  };
}
/** The configured container holding an explicit `clean_type.value`. */
function configuredType(value: number): RawDpCodec {
  return {
    decode: () => [{ field: 1, kind: "bytes", value: Buffer.from([0xff]) }],
    nested: (v: Buffer) =>
      v[0] === 0xff
        ? [{ field: 1, kind: "bytes", value: Buffer.from([value]) }]
        : [{ field: 1, kind: "int", value: BigInt(v[0]) }],
  };
}

describe("decodeCleanType (CleanParam.clean_type → cleanType)", () => {
  it("maps the types observed live", () => {
    expect(decodeCleanType("payload", configuredType(1))).toBe("mop");
    expect(decodeCleanType("payload", configuredType(2))).toBe("sweepAndMop");
  });

  it("reads an explicit zero as sweep", () => {
    expect(decodeCleanType("payload", configuredType(0))).toBe("sweep");
  });

  it("returns undefined when the configured container is present but empty", () => {
    expect(
      decodeCleanType("payload", cleanParam([{ field: 1, kind: "bytes", value: Buffer.alloc(0) }])),
    ).toBeUndefined();
  });

  it("returns undefined when the configured container is absent — no fabricated sweep", () => {
    expect(
      decodeCleanType("payload", cleanParam([{ field: 4, kind: "bytes", value: Buffer.from([1]) }])),
    ).toBeUndefined();
    expect(decodeCleanType("payload", cleanParam([]))).toBeUndefined();
  });

  it("returns undefined for an unmapped type, a bad payload, or no codec", () => {
    expect(decodeCleanType("payload", configuredType(9))).toBeUndefined();
    expect(decodeCleanType("payload", fakeCodec(undefined))).toBeUndefined();
    expect(decodeCleanType("payload", undefined)).toBeUndefined();
    expect(decodeCleanType(7, configuredType(1))).toBeUndefined();
  });
});

/**
 * The derived surface, pinned at COMPILE time. The decoded reads are the interesting half: a `decode`'s
 * declared return type wins over the stored `type`, so `activity` surfaces the named union rather than
 * the `string` the DP is stored as. Widening either decode would fail the build here.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const vac: VacuumCleanActions;

const _power: Exact<typeof vac.power, boolean | undefined> = true;
const _battery: Exact<typeof vac.battery, number | undefined> = true;
const _activity: Exact<typeof vac.activity, VacuumActivity | undefined> = true;
const _cleanType: Exact<typeof vac.cleanType, VacuumCleanType | TuyaCleanType | undefined> = true;

// setPower is gated by paramIds.has(151) — optional on the surface (absent until DP 151 is reported).
const _setPowerOptional: Exact<undefined extends typeof vac.setPower ? true : false, true> = true;
const _setPowerArg: Exact<Parameters<NonNullable<typeof vac.setPower>>[0], boolean> = true;

// Read-only members get no setter — nothing writes the activity or the battery back.
const _noSetActivity: Exact<"setActivity" extends keyof VacuumCleanActions ? true : false, false> = true;
const _noSetBattery: Exact<"setBattery" extends keyof VacuumCleanActions ? true : false, false> = true;

// startCleaning is a MethodMember gated by isAiotVacuum or DP 2 in paramIds — absent only on Tuya-category devices that haven't reported DP 2.
const _startCleaning: Exact<typeof vac.startCleaning, (() => Promise<void>) | undefined> = true;

// errorCode is an evidence-gated read for the legacy Tuya clean line.
const _errorCode: Exact<typeof vac.errorCode, number | undefined> = true;

// doNotDisturb and rssi are DP-gated reads — absent until DPs 107 / 134 are reported.
const _doNotDisturb: Exact<typeof vac.doNotDisturb, boolean | undefined> = true;
// A `readsFrom` member derives its surface type from its own `decode`, exactly as an owning one does.
const _doNotDisturbActive: Exact<typeof vac.doNotDisturbActive, boolean | undefined> = true;
const _rssi: Exact<typeof vac.rssi, number | undefined> = true;

// language and volume are AIoT-only READS. Neither ships a setter: the write direction for both
// rests on the product schema's `writable: true` alone, with no live publishDps capture, and an AIoT
// dp write dispatches for real rather than being refused by a router guard.
const _language: Exact<typeof vac.language, string | undefined> = true;
const _volume: Exact<typeof vac.volume, number | undefined> = true;

export const _surfaceAssertions = [
  _power,
  _battery,
  _activity,
  _cleanType,
  _setPowerOptional,
  _setPowerArg,
  _noSetActivity,
  _noSetBattery,
  _startCleaning,
  _errorCode,
  _doNotDisturb,
  _doNotDisturbActive,
  _rssi,
  _language,
  _volume,
];

/**
 * `ErrorCode` (DP 177). Both code lists are `repeated uint32`, which proto3 encodes PACKED by
 * default — one length-delimited run of varints, not one field per value. A sender may still emit the
 * unpacked form, so both are exercised against real bytes.
 */
/** A packed `repeated uint32` field: one length-delimited run of concatenated varints. */
function packed(field: number, values: readonly number[]): number[] {
  return sub(
    field,
    values.flatMap((v) => varint(v)),
  );
}

describe("decodeVacuumFault (ErrorCode → fault code)", () => {
  it("reads the first packed error code", () => {
    expect(decodeVacuumFault(frame(packed(2, [77])), byteCodec)).toBe(77);
    expect(decodeVacuumFault(frame(packed(2, [77, 3, 21])), byteCodec)).toBe(77);
  });

  it("reads a multi-byte code — the station and situational ranges are all above 127", () => {
    expect(decodeVacuumFault(frame(packed(2, [6113])), byteCodec)).toBe(6113);
    expect(decodeVacuumFault(frame(packed(3, [7055])), byteCodec)).toBe(7055);
  });

  it("reads the unpacked encoding too — a sender may emit either", () => {
    expect(decodeVacuumFault(frame(int(2, 40)), byteCodec)).toBe(40);
  });

  it("falls back to the first warning when no error is listed", () => {
    expect(decodeVacuumFault(frame(packed(3, [50, 51])), byteCodec)).toBe(50);
  });

  it("prefers an error over a warning — a fault that stops the robot is the more urgent answer", () => {
    expect(decodeVacuumFault(frame([...packed(2, [77]), ...packed(3, [50])]), byteCodec)).toBe(77);
  });

  it("is 0 when the device states no fault, including an empty list", () => {
    expect(decodeVacuumFault(frame([]), byteCodec)).toBe(0);
    expect(decodeVacuumFault(frame(packed(2, [])), byteCodec)).toBe(0);
    expect(decodeVacuumFault(frame([...packed(2, []), ...packed(3, [])]), byteCodec)).toBe(0);
  });

  it("ignores the fields around the code lists", () => {
    expect(decodeVacuumFault(frame([...int(1, 999), ...packed(2, [21]), ...sub(4, [])]), byteCodec)).toBe(21);
  });

  it("reads the legacy Tuya line's plain integer on the same property", () => {
    expect(decodeVacuumFault(0, byteCodec)).toBe(0);
    expect(decodeVacuumFault(106, byteCodec)).toBe(106);
    expect(decodeVacuumFault("77", byteCodec)).toBe(77);
    expect(decodeVacuumFault(3, undefined)).toBe(3);
  });

  it("is undefined when the device has not stated a fault at all", () => {
    expect(decodeVacuumFault(undefined, byteCodec)).toBeUndefined();
    expect(decodeVacuumFault(frame(packed(2, [77])), undefined)).toBeUndefined();
    expect(decodeVacuumFault("!!not-base64!!", byteCodec)).toBeUndefined();
  });
});

/**
 * `UndisturbedResponse` (DP 157) and `CleanStatistics` (DP 167). Both wrap their payload one or two
 * containers deep, and both rely on proto3 omitting zero values — so an empty container is a real
 * answer (off / no elapsed time), while an absent one is the device not answering.
 */
describe("decodeUnisetting (UnisettingResponse toggles)", () => {
  const CHILD_LOCK = 1;
  const MULTI_MAP = 3;
  const SMART_FOLLOW = 13;

  it("reads a switch through its wrapper", () => {
    expect(decodeUnisetting(frame(sub(CHILD_LOCK, int(1, 1))), byteCodec, CHILD_LOCK)).toBe(true);
  });

  it("reads an omitted zero as off", () => {
    expect(decodeUnisetting(frame(sub(CHILD_LOCK, [])), byteCodec, CHILD_LOCK)).toBe(false);
  });

  it("reads each toggle out of one message without disturbing the others", () => {
    // The whole point of one message carrying fifteen settings: every member reads its own field of
    // the same payload, and a field it does not name must not leak into its answer.
    const payload = frame([...sub(CHILD_LOCK, int(1, 1)), ...sub(MULTI_MAP, []), ...sub(SMART_FOLLOW, int(1, 1))]);
    expect(decodeUnisetting(payload, byteCodec, CHILD_LOCK)).toBe(true);
    expect(decodeUnisetting(payload, byteCodec, MULTI_MAP)).toBe(false);
    expect(decodeUnisetting(payload, byteCodec, SMART_FOLLOW)).toBe(true);
    // Field 9 is absent from this payload — not reported, which is not the same as off.
    expect(decodeUnisetting(payload, byteCodec, 9)).toBeUndefined();
  });

  it("is undefined when the setting is not reported at all", () => {
    expect(decodeUnisetting(frame(sub(MULTI_MAP, int(1, 1))), byteCodec, CHILD_LOCK)).toBeUndefined();
    expect(decodeUnisetting(frame(sub(CHILD_LOCK, int(1, 1))), undefined, CHILD_LOCK)).toBeUndefined();
    expect(decodeUnisetting(undefined, byteCodec, CHILD_LOCK)).toBeUndefined();
  });
});

describe("decodeConsumableHours (ConsumableRuntime parts)", () => {
  const SIDE_BRUSH = 1;
  const MOP = 6;
  const DIRTY_WATERTANK = 10;

  it("reads a part's hours through its Duration wrapper", () => {
    expect(decodeConsumableHours(frame(sub(SIDE_BRUSH, int(1, 42))), byteCodec, SIDE_BRUSH)).toBe(42);
  });

  it("reads a fitted-but-unused part as 0, not as missing", () => {
    expect(decodeConsumableHours(frame(sub(MOP, [])), byteCodec, MOP)).toBe(0);
  });

  it("reads each part out of one message, and respects the gap at 8 and 9", () => {
    // The vendor leaves 8 and 9 unused; the waste-water tank really is at 10. Renumbering around the
    // hole would report the water filter's hours as the tank's.
    const payload = frame([
      ...sub(SIDE_BRUSH, int(1, 10)),
      ...sub(MOP, int(1, 20)),
      ...sub(DIRTY_WATERTANK, int(1, 30)),
    ]);
    expect(decodeConsumableHours(payload, byteCodec, SIDE_BRUSH)).toBe(10);
    expect(decodeConsumableHours(payload, byteCodec, MOP)).toBe(20);
    expect(decodeConsumableHours(payload, byteCodec, DIRTY_WATERTANK)).toBe(30);
    expect(decodeConsumableHours(payload, byteCodec, 8)).toBeUndefined();
    expect(decodeConsumableHours(payload, byteCodec, 9)).toBeUndefined();
  });

  it("is undefined for a part this robot does not track", () => {
    expect(decodeConsumableHours(frame(sub(SIDE_BRUSH, int(1, 5))), byteCodec, MOP)).toBeUndefined();
    expect(decodeConsumableHours(frame(sub(SIDE_BRUSH, int(1, 5))), undefined, SIDE_BRUSH)).toBeUndefined();
    expect(decodeConsumableHours(undefined, byteCodec, SIDE_BRUSH)).toBeUndefined();
  });
});

describe("decodeDoNotDisturb (Undisturbed.sw → doNotDisturb)", () => {
  /** `UndisturbedResponse.undisturbed.sw.value` = on, with the live `active` flag beside it. */
  const dnd = (on: boolean): string => frame([...sub(1, int(1, 1)), ...sub(2, sub(1, on ? int(1, 1) : []))]);

  it("reads the switch through both wrapper messages", () => {
    expect(decodeDoNotDisturb(dnd(true), byteCodec)).toBe(true);
  });

  it("reads an omitted zero as off, at either level", () => {
    expect(decodeDoNotDisturb(dnd(false), byteCodec)).toBe(false);
    expect(decodeDoNotDisturb(frame(sub(2, [])), byteCodec)).toBe(false);
  });

  it("reads the switch, not the live in-window flag", () => {
    // active(1) = true while the window is open, but the feature itself is off. The property means
    // "is it enabled", so this has to answer false.
    expect(decodeDoNotDisturb(frame([...sub(1, int(1, 1)), ...sub(2, sub(1, []))]), byteCodec)).toBe(false);
  });

  it("reads the Tuya line's plain bool on the same property", () => {
    expect(decodeDoNotDisturb(true, byteCodec)).toBe(true);
    expect(decodeDoNotDisturb(false, byteCodec)).toBe(false);
    expect(decodeDoNotDisturb("true", undefined)).toBe(true);
    expect(decodeDoNotDisturb(1, undefined)).toBe(true);
    expect(decodeDoNotDisturb("0", undefined)).toBe(false);
  });

  it("is undefined when the device has not stated a window at all", () => {
    expect(decodeDoNotDisturb(frame([]), byteCodec)).toBeUndefined();
    expect(decodeDoNotDisturb(dnd(true), undefined)).toBeUndefined();
    expect(decodeDoNotDisturb(undefined, byteCodec)).toBeUndefined();
  });
});

describe("decodeDoNotDisturbActive (Undisturbed.active → doNotDisturbActive)", () => {
  /** The same payload shape the switch decode is exercised with: `active`(1) beside `undisturbed`(2). */
  const window = (active: number[]): string => frame([...sub(1, active), ...sub(2, sub(1, int(1, 1)))]);

  it("reads the live flag through a Switch wrapper", () => {
    expect(decodeDoNotDisturbActive(window(int(1, 1)), byteCodec)).toBe(true);
  });

  it("reads a bare varint too, since which shape the vendor sends is not confirmed", () => {
    // Both readings mean the same flag, so accepting either is what removes the guess rather than
    // adding one — a wrapper whose value is omitted, and a bare zero, are both "not open".
    expect(decodeDoNotDisturbActive(frame([...int(1, 1), ...sub(2, [])]), byteCodec)).toBe(true);
    expect(decodeDoNotDisturbActive(window([]), byteCodec)).toBe(false);
  });

  it("reads an omitted flag beside a stated window as closed, not as missing", () => {
    expect(decodeDoNotDisturbActive(frame(sub(2, sub(1, int(1, 1)))), byteCodec)).toBe(false);
  });

  it("answers the window, not the switch — the two disagree for most of the day", () => {
    // The feature is ON (sw.value = 1) but the quiet hours have not started. Reading the switch here
    // would tell a caller the robot is being quiet when it is not.
    expect(decodeDoNotDisturb(window([]), byteCodec)).toBe(true);
    expect(decodeDoNotDisturbActive(window([]), byteCodec)).toBe(false);
  });

  it("is undefined on anything that is not an UndisturbedResponse", () => {
    // The Tuya line's DP 107 is a plain bool carrying the SWITCH; borrowing it would answer a
    // different question than the one asked.
    expect(decodeDoNotDisturbActive(true, byteCodec)).toBeUndefined();
    expect(decodeDoNotDisturbActive("1", byteCodec)).toBeUndefined();
    expect(decodeDoNotDisturbActive(frame([]), byteCodec)).toBeUndefined();
    expect(decodeDoNotDisturbActive(window(int(1, 1)), undefined)).toBeUndefined();
    expect(decodeDoNotDisturbActive(undefined, byteCodec)).toBeUndefined();
  });
});

describe("decodeCleanParamValue (CleanParam settings beside clean_type)", () => {
  const CARPET = 2;
  const EXTENT = 3;
  const TIMES = 7;
  /** `clean_param`(1) wrapping the settings, as the device reports them. */
  const param = (body: number[]): string => frame(sub(1, body));

  it("reads a setting through its single-field wrapper", () => {
    expect(decodeCleanParamValue(param(sub(CARPET, int(1, 1))), byteCodec, CARPET)).toBe(1);
  });

  it("reads the wrapper's scalar wherever the vendor numbered it", () => {
    // The point of taking the first varint rather than asserting an inner field number: the wrapper's
    // field is named differently per setting (`value`, `strategy`, …) and this must not depend on that.
    expect(decodeCleanParamValue(param(sub(EXTENT, int(3, 2))), byteCodec, EXTENT)).toBe(2);
  });

  it("reads a present-but-empty wrapper as the zero member, not as missing", () => {
    expect(decodeCleanParamValue(param(sub(CARPET, [])), byteCodec, CARPET)).toBe(0);
    expect(decodeCleanParamValue(param(sub(CARPET, sub(9, []))), byteCodec, CARPET)).toBe(0);
  });

  it("reads a bare scalar too, for a setting the vendor did not wrap", () => {
    expect(decodeCleanParamValue(param(int(TIMES, 2)), byteCodec, TIMES)).toBe(2);
  });

  it("gives each setting its own answer out of the one payload", () => {
    const payload = param([...sub(1, int(1, 1)), ...sub(CARPET, int(1, 2)), ...sub(EXTENT, [])]);
    expect(decodeCleanParamValue(payload, byteCodec, CARPET)).toBe(2);
    expect(decodeCleanParamValue(payload, byteCodec, EXTENT)).toBe(0);
    // Not stated in this report — absent is not the same as the zero member.
    expect(decodeCleanParamValue(payload, byteCodec, TIMES)).toBeUndefined();
  });

  it("reads the CONFIGURED container, never the running one", () => {
    // running_clean_param(4) disagrees with the setting mid-change; reading it would report what the
    // job in progress is doing as though the user had chosen it.
    const payload = frame([...sub(1, sub(CARPET, int(1, 1))), ...sub(4, sub(CARPET, int(1, 2)))]);
    expect(decodeCleanParamValue(payload, byteCodec, CARPET)).toBe(1);
  });

  it("is undefined on anything that is not a CleanParam", () => {
    expect(decodeCleanParamValue(frame([]), byteCodec, CARPET)).toBeUndefined();
    expect(decodeCleanParamValue(param(sub(CARPET, int(1, 1))), undefined, CARPET)).toBeUndefined();
    expect(decodeCleanParamValue(true, byteCodec, CARPET)).toBeUndefined();
    expect(decodeCleanParamValue(undefined, byteCodec, CARPET)).toBeUndefined();
  });
});

describe("CleanParam settings on the bound surface", () => {
  const dps = new Set([VACUUM_DP.CLEAN_PARAM]);
  const payload = frame(
    sub(1, [...sub(1, int(1, 1)), ...sub(2, int(1, 1)), ...sub(3, []), ...sub(5, int(1, 1)), ...sub(7, int(1, 2))]),
  );

  const bound = () =>
    bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, dps), {
      rawDp: byteCodec,
      read: (name) => (name === "cleanType" ? { value: payload } : undefined),
    });

  it("answers every setting off the one DP 154 report", () => {
    const acts = bound().acts;
    expect(acts.cleanType).toBe("mop");
    expect(acts.carpetStrategy).toBe("avoid");
    expect(acts.cleanExtent).toBe("normal");
    expect(acts.smartMode).toBe(true);
    expect(acts.cleanTimes).toBe(2);
  });

  it("publishes one property for DP 154, however many members read it", () => {
    const named = VACUUM_CLEAN.properties.filter((p) => p.paramType === VACUUM_DP.CLEAN_PARAM).map((p) => p.name);
    expect(named).toEqual(["cleanType"]);
  });

  it("grows no setters — the whole message would have to be re-encoded to write one field", () => {
    const acts = bound().acts as Record<string, unknown>;
    for (const name of ["setCarpetStrategy", "setCleanExtent", "setSmartMode", "setCleanTimes"]) {
      expect(acts[name]).toBeUndefined();
    }
  });
});

describe("one payload, many reads — DP 176 settings and DP 168 consumables", () => {
  const settings = frame([...sub(1, int(1, 1)), ...sub(3, []), ...sub(13, int(1, 1))]);
  const consumables = frame([...sub(1, int(1, 120)), ...sub(6, []), ...sub(10, int(1, 30))]);
  const dps = new Set([VACUUM_DP.SETTINGS, VACUUM_DP.CONSUMABLES]);

  const bound = () =>
    bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, dps), {
      rawDp: byteCodec,
      read: (name) =>
        name === "childLock" ? { value: settings } : name === "sideBrushHours" ? { value: consumables } : undefined,
    });

  it("gives every settings toggle its own answer off the one DP 176 report", () => {
    const acts = bound().acts;
    expect(acts.childLock).toBe(true);
    expect(acts.multiMap).toBe(false);
    expect(acts.smartFollow).toBe(true);
    // Reported by neither the fixture nor the device — absent, which is not "off".
    expect(acts.livePhoto).toBeUndefined();
  });

  it("gives every consumable counter its own answer off the one DP 168 report", () => {
    const acts = bound().acts;
    expect(acts.sideBrushHours).toBe(120);
    expect(acts.mopHours).toBe(0);
    expect(acts.dirtyWaterTankHours).toBe(30);
    expect(acts.dustBagHours).toBeUndefined();
  });

  it("publishes exactly one property per DP, however many members read it", () => {
    // Eighteen getters over two data points. The schema still describes two reports, because that is
    // what the device sends — the extra readings are derived, not extra wire claims.
    const named = (dp: number) => VACUUM_CLEAN.properties.filter((p) => p.paramType === dp).map((p) => p.name);
    expect(named(VACUUM_DP.SETTINGS)).toEqual(["childLock"]);
    expect(named(VACUUM_DP.CONSUMABLES)).toEqual(["sideBrushHours"]);
  });

  it("installs none of them on a device that never reported the DP", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, new Set()), {
      rawDp: byteCodec,
    });
    expect(acts.childLock).toBeUndefined();
    expect(acts.smartFollow).toBeUndefined();
    expect(acts.sideBrushHours).toBeUndefined();
    expect(acts.mopHours).toBeUndefined();
  });

  it("grows no setters — every one of these is a read", () => {
    const acts = bound().acts as Record<string, unknown>;
    for (const name of ["setChildLock", "setMultiMap", "setSmartFollow", "setSideBrushHours", "setMopHours"]) {
      expect(acts[name]).toBeUndefined();
    }
  });
});

describe("doNotDisturbActive — a second reading of one DP (`readsFrom`)", () => {
  const payload = frame([...sub(1, int(1, 1)), ...sub(2, sub(1, int(1, 1)))]);
  const aiotDnd = new Set([VACUUM_DP.DO_NOT_DISTURB]);

  it("decodes the OWNER's stored property, not one named after itself", () => {
    // The whole point of the mechanism: `Device` stores DP 157 under `doNotDisturb`, so a getter
    // reading `doNotDisturbActive` would find nothing and answer undefined forever.
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDnd), {
      rawDp: byteCodec,
      read: (name) => (name === "doNotDisturb" ? { value: payload } : undefined),
    });
    expect(acts.doNotDisturb).toBe(true);
    expect(acts.doNotDisturbActive).toBe(true);
  });

  it("publishes no property of its own — DP 157 stays owned by one spec", () => {
    // A second spec for the same id is what `Device.specByParam` drops on the floor, and what the
    // one-owner guard exists to catch. The reading is derived; the param is not claimed twice.
    const forDp157 = VACUUM_CLEAN.properties.filter((p) => p.paramType === VACUUM_DP.DO_NOT_DISTURB);
    expect(forDp157.map((p) => p.name)).toEqual(["doNotDisturb"]);
  });

  it("is absent on a device that reports only the Tuya switch", () => {
    // DP 107 carries the switch and says nothing about the window, so the owner's read alias must not
    // drag this getter onto a device that cannot answer it.
    const tuyaOnly = new Set([TUYA_VACUUM_DP.FORBID_MODE]);
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home_tuya", tuyaOnly), {
      rawDp: byteCodec,
      read: (name) => (name === "doNotDisturb" ? { value: true } : undefined),
    });
    expect(acts.doNotDisturb).toBe(true);
    expect(acts.doNotDisturbActive).toBeUndefined();
  });

  it("grows no setter — a field inside a shared payload cannot be written on its own", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDnd), {
      rawDp: byteCodec,
    });
    expect((acts as Record<string, unknown>).setDoNotDisturbActive).toBeUndefined();
  });
});

describe("decodeCleanStat (CleanStatistics — the run beside the lifetime totals)", () => {
  it("reads the current run's duration", () => {
    expect(decodeCleanStat(frame(sub(1, int(1, 4200))), byteCodec, 1, 1)).toBe(4200);
  });

  it("reads a started-but-zero run as 0, not as missing", () => {
    expect(decodeCleanStat(frame(sub(1, [])), byteCodec, 1, 1)).toBe(0);
  });

  it("ignores the lifetime accumulators beside it", () => {
    // total(2) and user_total(3) carry a clean_duration at the same inner field number; reading the
    // wrong container would report a lifetime figure as the current run.
    const payload = frame([...sub(1, int(1, 60)), ...sub(2, int(1, 999999)), ...sub(3, int(1, 888888))]);
    expect(decodeCleanStat(payload, byteCodec, 1, 1)).toBe(60);
  });

  it("reads the Tuya line's plain integer on the same property", () => {
    expect(decodeCleanStat(4200, byteCodec, 1, 1)).toBe(4200);
    expect(decodeCleanStat("4200", undefined, 1, 1)).toBe(4200);
    expect(decodeCleanStat(0, undefined, 1, 1)).toBe(0);
  });

  it("is undefined when the device has not stated a run", () => {
    expect(decodeCleanStat(frame([]), byteCodec, 1, 1)).toBeUndefined();
    expect(decodeCleanStat(frame(sub(1, int(1, 60))), undefined, 1, 1)).toBeUndefined();
    expect(decodeCleanStat(undefined, byteCodec, 1, 1)).toBeUndefined();
  });
});

describe("one figure, two clean lines — CleanStatistics as a second source", () => {
  /** `single{duration,area}` + `user_total{duration,area,count}`, as an AIoT robot reports them. */
  const stats = frame([
    ...sub(1, [...int(1, 600), ...int(2, 12)]),
    ...sub(3, [...int(1, 360000), ...int(2, 4200), ...int(3, 210)]),
  ]);

  it("reads every figure out of the one DP 167 report on the AIoT line", () => {
    const { acts } = bind<VacuumCleanActions>(
      "vacuum_clean",
      fakeCtx(undefined, undefined, new Set([VACUUM_DP.CLEAN_STATS])),
      {
        rawDp: byteCodec,
        read: (name) => (name === "clearTime" ? { value: stats } : undefined),
      },
    );
    expect(acts.clearTime).toBe(600);
    expect(acts.clearArea).toBe(12);
    expect(acts.lifetimeCleanTime).toBe(360000);
    expect(acts.lifetimeCleanArea).toBe(4200);
    expect(acts.lifetimeCleanCount).toBe(210);
  });

  it("keeps reading the Tuya line's own DPs under the same names", () => {
    // The point of the second source: one name per figure, whichever family the device is on. A Tuya
    // robot reports each figure on its own DP and must not be routed through the protobuf path.
    const tuyaDps = new Set([
      TUYA_VACUUM_DP.CLEAR_TIME,
      TUYA_VACUUM_DP.CLEAR_AREA,
      TUYA_VACUUM_DP.CLEAR_TOTAL_TIME,
      TUYA_VACUUM_DP.CLEAR_TOTAL_AREA,
    ]);
    const values: Record<string, number> = {
      clearTime: 600,
      clearArea: 12,
      lifetimeCleanTime: 360000,
      lifetimeCleanArea: 4200,
    };
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home_tuya", tuyaDps), {
      rawDp: byteCodec,
      read: (name) => (name in values ? { value: values[name] } : undefined),
    });
    expect(acts.clearTime).toBe(600);
    expect(acts.clearArea).toBe(12);
    expect(acts.lifetimeCleanTime).toBe(360000);
    expect(acts.lifetimeCleanArea).toBe(4200);
    // No Tuya DP carries a run count, and DP 167 is absent here — so it is not offered at all.
    expect(acts.lifetimeCleanCount).toBeUndefined();
  });

  it("prefers a member's own wire over the borrowed payload", () => {
    // A device reporting both must answer from its own DP. Borrowing is the fallback, not the default.
    const both = new Set([VACUUM_DP.CLEAN_STATS, TUYA_VACUUM_DP.CLEAR_AREA]);
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, both), {
      rawDp: byteCodec,
      read: (name) => (name === "clearTime" ? { value: stats } : name === "clearArea" ? { value: 99 } : undefined),
    });
    expect(acts.clearArea).toBe(99);
  });

  it("still publishes one property per DP — the borrowed id is not claimed twice", () => {
    const named = (dp: number) => VACUUM_CLEAN.properties.filter((p) => p.paramType === dp).map((p) => p.name);
    expect(named(VACUUM_DP.CLEAN_STATS)).toEqual(["clearTime"]);
    // Each second-source member keeps its OWN spec, which is what makes it readable on the Tuya line.
    expect(named(TUYA_VACUUM_DP.CLEAR_AREA)).toEqual(["clearArea"]);
    expect(named(TUYA_VACUUM_DP.CLEAR_TOTAL_AREA)).toEqual(["lifetimeCleanArea"]);
  });

  it("grows no setters — every one of these is an accumulator the device owns", () => {
    const { acts } = bind<VacuumCleanActions>(
      "vacuum_clean",
      fakeCtx(undefined, undefined, new Set([VACUUM_DP.CLEAN_STATS])),
      {
        rawDp: byteCodec,
      },
    );
    const a = acts as Record<string, unknown>;
    for (const n of ["setClearArea", "setLifetimeCleanTime", "setLifetimeCleanArea", "setLifetimeCleanCount"]) {
      expect(a[n]).toBeUndefined();
    }
  });
});

describe("vacuum_clean — DP-based action routing", () => {
  // AIoT device: has reported DP 151 (power) and DP 153 (work status). DP 152 (MODE_CTRL) is write-only and never in paramIds.
  const aiotDps = new Set([VACUUM_DP.POWER, VACUUM_DP.WORK_STATUS]);
  // Tuya device: has reported DP 2 (play/pause) and DP 101 (go home).
  const tuyaDps = new Set([LEGACY_VACUUM_DP.PLAY_PAUSE, LEGACY_VACUUM_DP.GO_HOME]);

  it("write actions are present for non-Tuya-category devices — AIoT path (isAiotVacuum)", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2250", undefined, aiotDps));
    expect(acts.startCleaning).toBeDefined();
    expect(acts.returnToDock).toBeDefined();
    expect(acts.pauseCleaning).toBeDefined();
  });

  it("write actions are absent for Tuya-category device with no Tuya DPs — bootstrapping window", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home_tuya"));
    expect(acts.startCleaning).toBeUndefined();
    expect(acts.returnToDock).toBeUndefined();
    expect(acts.pauseCleaning).toBeUndefined();
  });

  it("write actions are absent on a Tuya device, even when it reported DP 2 and DP 101", () => {
    // No Tuya clean-line write has been confirmed on a device, and dispatching one would route
    // through the Tuya command router, which refuses unverified writes by default. An advertised
    // verb that throws on the happy path is worse than an absent one.
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2266", "eufy_home_tuya", tuyaDps));
    expect(acts.startCleaning).toBeUndefined();
    expect(acts.returnToDock).toBeUndefined();
    expect(acts.pauseCleaning).toBeUndefined();
  });

  it("dispatches the AIoT ModeCtrl frame, never a legacy bool DP", async () => {
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2351", undefined, tuyaDps));
    await acts.startCleaning!();
    await acts.returnToDock!();
    await acts.pauseCleaning!();
    expect(sent.every((c) => (c as { dp: number }).dp === VACUUM_DP.MODE_CTRL)).toBe(true);
  });

  it("setPower is absent on the Tuya clean line — no confirmed power DP there", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2266", "eufy_home_tuya", tuyaDps));
    expect(acts.setPower).toBeUndefined();
  });

  it("setPower is present on an AIoT device that has not reported DP 151", () => {
    // DP 151 belongs to the shared AIoT product schema rather than to a device's reported set, so the
    // write is gated on the platform. Gating it on the reported DP hid it on real devices.
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2351", undefined, new Set()));
    expect(acts.setPower).toBeDefined();
  });

  it("dispatches DP 151 for setPower when DP 151 is in paramIds — AIoT clean line", async () => {
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDps));
    await acts.setPower!(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "aiot-dp", dp: 151, value: true });
  });

  it("dispatches a ModeCtrlRequest for startCleaning — AIoT path (isAiotVacuum, no legacy DP 2)", async () => {
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDps));
    await acts.startCleaning!();
    expect(sent[0]).toMatchObject({ kind: "aiot-dp", dp: 152 });
  });

  it("doNotDisturb is read-only — setter absent even when DP 107 is in paramIds", () => {
    const dps = new Set([TUYA_VACUUM_DP.FORBID_MODE]);
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, dps));
    expect((acts as Record<string, unknown>).setDoNotDisturb).toBeUndefined();
  });

  it("doNotDisturb getter is absent when DP 107 is not in paramIds", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDps));
    expect(acts.doNotDisturb).toBeUndefined();
  });

  it("language and volume are reads only — no setter is installed on any device", () => {
    // The write direction for DP 161 and DP 162 rests on the product schema's `writable: true` and
    // no live publishDps capture. Unlike a Tuya dp write, an AIoT one is not refused by a router
    // guard — it reaches the device — so the setter stays off the surface until a capture exists.
    for (const category of ["eufy_home", "eufy_home_tuya", undefined]) {
      const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, category));
      expect((acts as Record<string, unknown>).setLanguage).toBeUndefined();
      expect((acts as Record<string, unknown>).setVolume).toBeUndefined();
    }
  });

  it("language and volume still read on an AIoT vacuum", () => {
    const reported = new Set([VACUUM_DP.LANGUAGE, VACUUM_DP.VOLUME]);
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", reported), {
      read: (name) => (name === "language" ? { value: "en" } : name === "volume" ? { value: 38 } : undefined),
    });
    expect(acts.language).toBe("en");
    expect(acts.volume).toBe(38);
  });
});
