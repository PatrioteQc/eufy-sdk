import type { CommandContext } from "../types.js";
import { VACUUM_DOCK, type VacuumDockActions } from "../vacuum-dock.js";
import { bind } from "./bind.js";

function dockCtx(model?: string, category?: string): CommandContext {
  return { channel: 0, codec: "vacuum", model, category, paramIds: new Set([173]) };
}

describe("vacuum_dock capability module", () => {
  it("declares the capability + schema", () => {
    expect(VACUUM_DOCK.capability).toBe("vacuum_dock");
    // writeOnly members are excluded from the property schema; only dockState (unexposed) is included.
    expect(VACUUM_DOCK.properties.map((p) => p.name)).toEqual(["dockState"]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of VACUUM_DOCK.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("is detected by DP 173, not as a vacuum-codec baseline", () => {
    expect(VACUUM_DOCK.detection?.evidenceParams).toEqual([173]);
    expect(VACUUM_DOCK.detection?.codecs).toBeUndefined();
  });

  it("is a clean-line module", () => {
    expect(VACUUM_DOCK.line).toBe("clean");
  });
});

describe("vacuum_dock — write members are unverified (no setters installed)", () => {
  it("emptyDust / washMops / dryMops are absent on the bound object — unverified until StationRequest is captured", () => {
    const { acts } = bind<VacuumDockActions>("vacuum_dock", dockCtx("T2351"));
    // All write members are unverified — no setter is installed regardless of category.
    expect((acts as Record<string, unknown>).emptyDust).toBeUndefined();
    expect((acts as Record<string, unknown>).washMops).toBeUndefined();
    expect((acts as Record<string, unknown>).dryMops).toBeUndefined();
  });

  it("emptyDust / washMops / dryMops are also absent when model and category are both absent", () => {
    const { acts } = bind<VacuumDockActions>("vacuum_dock", dockCtx(undefined));
    expect((acts as Record<string, unknown>).emptyDust).toBeUndefined();
    expect((acts as Record<string, unknown>).washMops).toBeUndefined();
    expect((acts as Record<string, unknown>).dryMops).toBeUndefined();
  });

  it("dockState has no typed getter (unexposed) on the bound object", () => {
    const { acts } = bind<VacuumDockActions>("vacuum_dock", dockCtx("T2351"));
    // dockState is unexposed — no getter is installed on the surface.
    expect((acts as Record<string, unknown>).dockState).toBeUndefined();
  });
});
