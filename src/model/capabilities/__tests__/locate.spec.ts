import type { CommandContext } from "../types.js";
import { LOCATE, type LocateActions } from "../locate.js";
import { bind } from "./bind.js";

function locateCtx(model?: string, category?: string): CommandContext {
  return { channel: 0, codec: "vacuum", model, category, paramIds: new Set() };
}

describe("locate capability module", () => {
  it("declares the capability + schema", () => {
    expect(LOCATE.capability).toBe("locate");
    expect(LOCATE.properties.map((p) => p.name)).toEqual(["locating"]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of LOCATE.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("is a vacuum-codec baseline", () => {
    expect(LOCATE.detection?.codecs).toEqual(["vacuum"]);
  });
});

describe("locate — AIoT vs legacy guard (negative exclusion)", () => {
  it("locate is present when category is absent — defaults to AIoT", () => {
    const { acts } = bind<LocateActions>("locate", locateCtx("T2250"));
    expect(acts.locate).toBeDefined();
  });

  it("locate is present when model and category are both absent — defaults to AIoT", () => {
    const { acts } = bind<LocateActions>("locate", locateCtx(undefined));
    expect(acts.locate).toBeDefined();
  });

  it("locate is absent for eufy_home_tuya — absent rather than present-and-rejecting", () => {
    // T2266 = X8 Pro, category from live API dump (2026-08-04)
    const { acts } = bind<LocateActions>("locate", locateCtx("T2266", "eufy_home_tuya"));
    expect(acts.locate).toBeUndefined();
  });

  it("dispatches DP 160 = true for eufy_home category (Anker AIoT MQTT)", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(undefined, "eufy_home"));
    await acts.locate!();
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 160, value: true }]);
  });

  it("dispatches DP 160 = false when called with false (eufy_home category)", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(undefined, "eufy_home"));
    await acts.locate!(false);
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 160, value: false }]);
  });
});
