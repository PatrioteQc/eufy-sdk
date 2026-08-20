import type { CommandContext } from "../types.js";
import { LOCATE, type LocateActions } from "../locate.js";
import { bind } from "./bind.js";

function locateCtx(paramIds: ReadonlySet<number> = new Set()): CommandContext {
  return { channel: 0, codec: "vacuum", paramIds };
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

describe("locate — DP-based routing", () => {
  it("locate is present on AIoT device without any DPs — isAiotVacuum gate (always available)", () => {
    const { acts } = bind<LocateActions>("locate", locateCtx(new Set()));
    expect(acts.locate).toBeDefined();
  });

  it("locate is absent for Tuya-category device when DP 103 is not in paramIds", () => {
    const ctx = { ...locateCtx(new Set()), category: "eufy_home_tuya" };
    const { acts } = bind<LocateActions>("locate", ctx);
    expect(acts.locate).toBeUndefined();
  });

  it("locate is present for Tuya-category device when DP 103 is in paramIds", () => {
    const ctx = { ...locateCtx(new Set([103])), category: "eufy_home_tuya" };
    const { acts } = bind<LocateActions>("locate", ctx);
    expect(acts.locate).toBeDefined();
  });

  it("locate is present when DP 160 is in paramIds — AIoT path", () => {
    const { acts } = bind<LocateActions>("locate", locateCtx(new Set([160])));
    expect(acts.locate).toBeDefined();
  });

  it("locate is present when DP 103 is in paramIds — Tuya path", () => {
    const { acts } = bind<LocateActions>("locate", locateCtx(new Set([103])));
    expect(acts.locate).toBeDefined();
  });

  it("dispatches DP 160 = true when DP 160 is in paramIds — AIoT path", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(new Set([160])));
    await acts.locate!();
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 160, value: true }]);
  });

  it("dispatches DP 160 = false when called with false — AIoT path", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(new Set([160])));
    await acts.locate!(false);
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 160, value: false }]);
  });

  it("dispatches DP 103 = true when DP 103 is in paramIds — Tuya path", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(new Set([103])));
    await acts.locate!();
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 103, value: true }]);
  });

  it("dispatches DP 103 = false when called with false — Tuya path", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(new Set([103])));
    await acts.locate!(false);
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 103, value: false }]);
  });

  it("prefers DP 103 when both DP 103 and DP 160 are in paramIds", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(new Set([103, 160])));
    await acts.locate!();
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 103, value: true }]);
  });
});
