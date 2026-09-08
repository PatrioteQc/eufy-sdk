import {
  BATTERY,
  BATTERY_PARAM,
  resolveWorkingMode,
  resolveWorkingModeValue,
  WORKING_MODE_MAPS,
  WorkingMode,
  PowerSource,
  type BatteryActions,
  type WorkingModeName,
  type PowerSourceName,
} from "../battery.js";
import { buildCommand } from "../index.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import type { Capability } from "../../types.js";

/**
 * A ctx for a fully-reporting battery camera. Every write is now gated on the device reporting the
 * param it reads back, so a bare `paramIds` resolves no command at all — which is the point: a T8900
 * entry sensor reports a level and nothing else, and must not be handed a power-source frame.
 */
const evidenced = (over: Partial<CommandContext> = {}): CommandContext => ({
  channel: 0,
  codec: "camera",
  capabilities: new Set<Capability>(["battery"]),
  paramIds: new Set(BATTERY.properties.map((p) => p.paramType)),
  ...over,
});

describe("battery capability module", () => {
  it("exposes WorkingMode + PowerSource enums with the app's canonical values", () => {
    expect(WorkingMode.OptimalBatteryLife).toBe("Optimal Battery Life");
    expect(WorkingMode.CustomizeRecording).toBe("Customize Recording");
    expect(PowerSource.Battery).toBe("battery");
    expect(PowerSource.ExternalSolarPanel).toBe("external");
    // every WorkingMode value must exist in the DEFAULT or a model map (no typos).
    const known = new Set(Object.values(WORKING_MODE_MAPS).flatMap((m) => Object.values(m)));
    for (const name of Object.values(WorkingMode)) expect(known.has(name)).toBe(true);
  });

  it("declares the capability + schema", () => {
    expect(BATTERY.capability).toBe("battery");
    expect(BATTERY.properties.map((p) => p.name)).toEqual([
      "battery",
      "charging",
      "powerSource",
      "workingMode",
      "recordDuration",
      "recordInterval",
      "recordAutoStop",
      "batteryTemperature",
      "batteryHealth",
      "solarIntensity",
      "solarConnected24h",
      "batteryPowerStats",
      "cameraInfo",
    ]);
  });

  it("proves battery via the reported battery-level param 1101", () => {
    expect(BATTERY.detection?.evidenceParams).toContain(1101);
  });

  it("writes recordAutoStop as an INVERTED station-scalar on the device channel (wire-verified T8170)", () => {
    const ctx = evidenced({ channel: 1 });
    // OFF ⇒ value 1, ON ⇒ value 0 (inverted); 132-byte station-scalar body (no channel word) on ch1.
    expect(buildCommand("recordAutoStop", false, ctx)).toEqual({
      kind: "p2p-station-scalar",
      cmd: BATTERY_PARAM.RECORD_AUTO_STOP,
      value: 1,
      channel: 1,
    });
    expect(buildCommand("recordAutoStop", true, ctx)).toEqual({
      kind: "p2p-station-scalar",
      cmd: BATTERY_PARAM.RECORD_AUTO_STOP,
      value: 0,
      channel: 1,
    });
  });

  it("writes recordDuration/recordInterval as station-scalars on the device channel (wire-verified T8170)", () => {
    const ctx = evidenced({ channel: 1 });
    expect(buildCommand("recordDuration", 70, ctx)).toEqual({
      kind: "p2p-station-scalar",
      cmd: BATTERY_PARAM.RECORD_DURATION,
      value: 70,
      channel: 1,
    });
    expect(buildCommand("recordInterval", 10, ctx)).toEqual({
      kind: "p2p-station-scalar",
      cmd: BATTERY_PARAM.RECORD_INTERVAL,
      value: 10,
      channel: 1,
    });
  });

  it("keeps workingMode (1246) a raw number — the value→mode map is device-specific, not a universal enum", () => {
    const wm = BATTERY.properties.find((p) => p.name === "workingMode");
    expect(wm?.type).toBe("number");
    // No hardcoded enumValues: T8170 value 2 = "Customize Recording" but T8214 value 0 =
    // "Balance Surveillance" — the app maps per model, so a static enum would mislabel.
    expect(wm?.enumValues).toBeUndefined();
  });

  it("resolveWorkingMode maps per model — cameras use DEFAULT, the T8214 doorbell its own map (confirmed live)", () => {
    // 3-mode cameras (identity) via DEFAULT fallback.
    expect(resolveWorkingMode("T8170T0000000000", 2)).toBe("Customize Recording");
    expect(resolveWorkingMode("T8124", 0)).toBe("Optimal Battery Life");
    expect(resolveWorkingMode("T8110", 1)).toBe("Optimal Surveillance");
    // T8214 doorbell — its own 4-mode map (0 = Balance Surveillance, 3 = Optimal Battery Life).
    expect(resolveWorkingMode("T8214T2124", 0)).toBe("Balance Surveillance");
    expect(resolveWorkingMode("T8214T2124", 3)).toBe("Optimal Battery Life");
    // Unknown value → undefined; unknown model → DEFAULT.
    expect(resolveWorkingMode("T8170", 9)).toBeUndefined();
    expect(resolveWorkingMode("T9999", 0)).toBe("Optimal Battery Life");
    expect(WORKING_MODE_MAPS.DEFAULT[2]).toBe("Customize Recording");
  });

  it("writes workingMode as a direct-binary cmd 1246 (decrypted wire, verified live T8124R)", () => {
    const ctx = evidenced({ channel: 6 });
    expect(buildCommand("workingMode", 1, ctx)).toEqual({
      kind: "set-param",
      param: 1246,
      value: 1,
      form: "direct-binary",
      channel: 6,
    });
  });

  it("writes powerSource as a 1350 SET_PAYLOAD (cmd 1293, {charge_mode}, mValue3:0) — decrypted from the app", () => {
    const ctx = evidenced({ channel: 6 });
    // External Solar Panel = charge_mode 1 (byte-confirmed by decrypting the app's own frame).
    expect(buildCommand("powerSource", 1, ctx)).toEqual({
      kind: "set-payload",
      cmd: 1293,
      payload: { charge_mode: 1 },
      channel: 6,
      mValue3: 0,
    });
    // Battery = charge_mode 0.
    expect(buildCommand("powerSource", 0, ctx)).toEqual({
      kind: "set-payload",
      cmd: 1293,
      payload: { charge_mode: 0 },
      channel: 6,
      mValue3: 0,
    });
  });

  /**
   * `powerSource`'s own lambda maps anything that isn't `"external"`/`1` onto charge_mode 0, so before
   * the domain was enforced for it, `5` dispatched a real frame that set the source to Battery — a
   * fire-and-forget write of a value the member's own message calls invalid, looking like success.
   */
  it("powerSource rejects a value outside its enum instead of writing a plausible-looking one", async () => {
    const ctx = evidenced({ channel: 6 });
    expect(() => buildCommand("powerSource", 5, ctx)).toThrow(
      /powerSource: 5 is not a valid value \(must be one of 0\/1\)/,
    );
    const { acts, sent } = bind<BatteryActions>("battery", ctx);
    await expect(acts.setPowerSource!(5)).rejects.toThrow(
      /powerSource: 5 is not a valid value \(must be one of 0\/1\)/,
    );
    expect(sent).toEqual([]);
  });

  it("a setter REFUSES an unbuildable value rather than silently no-op — matches setProperty", async () => {
    // "Balance Surveillance" is a real mode name, but a 3-mode T8124 doesn't offer it → resolves to no
    // command. The derived setter must refuse (like setProperty) rather than succeed on a typo.
    const ctx = evidenced({ channel: 6, model: "T8124" });
    const { acts, sent } = bind<BatteryActions>("battery", ctx);
    await expect(acts.setWorkingMode!(WorkingMode.BalanceSurveillance)).rejects.toThrow(
      'workingMode: "Balance Surveillance" is not a valid value',
    );
    expect(sent).toEqual([]);
  });

  it("setWorkingMode accepts a mode NAME resolved per model (resolveWorkingModeValue)", () => {
    // 3-mode cameras (DEFAULT): Optimal Battery Life = 0, Customize Recording = 2.
    expect(resolveWorkingModeValue("T8124R", "Optimal Battery Life")).toBe(0);
    expect(resolveWorkingModeValue("T8170", "Customize Recording")).toBe(2);
    // T8214 doorbell has a scrambled map: Optimal Battery Life = 3, Balance Surveillance = 0.
    expect(resolveWorkingModeValue("T8214", "Optimal Battery Life")).toBe(3);
    expect(resolveWorkingModeValue("T8214", "Balance Surveillance")).toBe(0);
    // a mode the model doesn't offer → undefined.
    expect(resolveWorkingModeValue("T8124", "Balance Surveillance")).toBeUndefined();
    // buildCommand resolves the name via ctx.model → the direct-binary 1246 command.
    const ctx = evidenced({ channel: 6, model: "T8214" });
    expect(buildCommand("workingMode", "Optimal Battery Life", ctx)).toEqual({
      kind: "set-param",
      param: 1246,
      value: 3,
      form: "direct-binary",
      channel: 6,
    });
  });

  /**
   * Read through the descriptors: a getter must not be INVOKED to be enumerated, and the setters are the
   * function-valued half. The getter list is every one the schema publishes, and neither unexposed param.
   */
  it("the bound object exposes the fluent dev.battery() setters that dispatch the decrypted wires", async () => {
    const ctx = evidenced({ channel: 6 });
    const { acts, sent } = bind<BatteryActions>("battery", ctx);
    const own = Object.getOwnPropertyDescriptors(acts);
    expect(
      Object.keys(own)
        .filter((k) => typeof own[k].value === "function")
        .sort(),
    ).toEqual(["setPowerSource", "setRecordAutoStop", "setRecordDuration", "setRecordInterval", "setWorkingMode"]);
    expect(Object.keys(own).filter((k) => own[k].get)).toEqual([
      "level",
      "charging",
      "powerSource",
      "workingMode",
      "recordDuration",
      "recordInterval",
      "recordAutoStop",
      "temperature",
      "health",
      "solarIntensity",
      "solarConnected24h",
    ]);
    await acts.setPowerSource!(PowerSource.ExternalSolarPanel);
    await acts.setWorkingMode!(WorkingMode.OptimalBatteryLife); // no ctx.model → DEFAULT map → 0
    expect(sent[0]).toEqual({ kind: "set-payload", cmd: 1293, payload: { charge_mode: 1 }, channel: 6, mValue3: 0 });
    expect(sent[1]).toEqual({ kind: "set-param", param: 1246, value: 0, form: "direct-binary", channel: 6 });
  });

  it("derives `charging` from BATTERY_STATUS (2111) as value ∉ {0,2} — matching the app decode", () => {
    const charging = BATTERY.properties.find((p) => p.name === "charging");
    expect(charging?.paramType).toBe(BATTERY_PARAM.BATTERY_STATUS);
    const decode = charging?.decode; // the member's ingest-time `coerce`, projected onto the schema
    expect(decode).toBeDefined();
    // 0 / 2 = not charging; anything else (e.g. 4 = solar-connected trickle) = charging.
    expect(decode!("0")).toBe(false);
    expect(decode!("2")).toBe(false);
    expect(decode!("4")).toBe(true);
    expect(decode!("1")).toBe(true);
  });
});

/**
 * The derived surface, pinned at COMPILE time — these assertions have no runtime half, which is the
 * point: what a developer sees in the editor is the same table the runtime installs from, and the two
 * cannot drift. Checked by `npm run typecheck`; a widened type fails the build here.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const bat: BatteryActions;

// A getter is optional (evidence-gated) and narrowed to what the member declares it is stored as.
const _level: Exact<typeof bat.level, number | undefined> = true;
const _charging: Exact<typeof bat.charging, boolean | undefined> = true;
const _recordAutoStop: Exact<typeof bat.recordAutoStop, boolean | undefined> = true;

// `accepts` widens the SETTER past the getter: a mode/source NAME as well as the index that is stored.
const _workingModeRead: Exact<typeof bat.workingMode, number | undefined> = true;
const _workingModeWrite: Exact<Parameters<NonNullable<typeof bat.setWorkingMode>>[0], WorkingModeName | number> = true;
const _powerSourceWrite: Exact<Parameters<NonNullable<typeof bat.setPowerSource>>[0], PowerSourceName | number> = true;

// Every write is evidence-gated, so every setter is OPTIONAL — a caller is made to check.
const _setClipOptional: Exact<undefined extends typeof bat.setRecordDuration ? true : false, true> = true;
const _setWorkingOptional: Exact<undefined extends typeof bat.setWorkingMode ? true : false, true> = true;

// Read-only members get no setter.
const _noSetLevel: Exact<"setLevel" extends keyof BatteryActions ? true : false, false> = true;
const _noSetCharging: Exact<"setCharging" extends keyof BatteryActions ? true : false, false> = true;

// Reported but unexposed: in the schema, reachable via getProperty, NOT on the typed surface. 1103 is
// pinned here by BOTH names — a getter over it must not reappear under either.
const _noCameraInfo: Exact<"cameraInfo" extends keyof BatteryActions ? true : false, false> = true;
const _noPowerStats: Exact<"batteryPowerStats" extends keyof BatteryActions ? true : false, false> = true;
const _noBatteryLow: Exact<"batteryLow" extends keyof BatteryActions ? true : false, false> = true;

export const _surfaceAssertions = [
  _level,
  _charging,
  _recordAutoStop,
  _workingModeRead,
  _workingModeWrite,
  _powerSourceWrite,
  _setClipOptional,
  _setWorkingOptional,
  _noSetLevel,
  _noSetCharging,
  _noCameraInfo,
  _noPowerStats,
  _noBatteryLow,
];
