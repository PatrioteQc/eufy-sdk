import { describe, expect, it } from "vitest";
import { resolvedStationSn } from "../device-registry.js";

/**
 * Which station a device's traffic belongs to, answerable without opening any media.
 *
 * A caller deciding what may run at once needs to group devices by the thing that is actually contended: a
 * HomeBase fans several cameras out over ONE session and serves them one at a time, while a standalone camera
 * is its own session and contends with nobody. Without the grouping a caller either serialises everything,
 * which penalises standalone devices for a base's limit, or serialises nothing.
 *
 * `parent_sn` is the field that is actually populated for an attached device. `station_sn` is frequently
 * absent — observed empty on every attached sensor of a T8010 — so keying on it alone silently resolves an
 * attached device to ITSELF, which is the answer that says "standalone" and is exactly wrong there.
 *
 * A standalone device answering its OWN serial is what "stands alone" means, and it makes the value a total
 * function: every device has a station, and a device with no parent is its own.
 */
describe("resolvedStationSn", () => {
  it("answers the parent for a device attached to a base", () => {
    expect(resolvedStationSn({ parent_sn: "T8010P0000000000", station_sn: "" }, "T8210P0000000001")).toBe(
      "T8010P0000000000",
    );
  });

  it("prefers the parent over a station field that disagrees with it", () => {
    expect(
      resolvedStationSn({ parent_sn: "T8010P0000000000", station_sn: "T9999P0000000000" }, "T8210P0000000001"),
    ).toBe("T8010P0000000000");
  });

  it("answers a standalone device its own serial, which is what standing alone means", () => {
    expect(resolvedStationSn({ parent_sn: "T8410P0000000002" }, "T8410P0000000002")).toBe("T8410P0000000002");
  });

  it("answers its own serial when the record names no parent at all", () => {
    expect(resolvedStationSn({}, "T8410P0000000002")).toBe("T8410P0000000002");
  });

  it("falls back to the station field when there is one and no parent", () => {
    expect(resolvedStationSn({ station_sn: "T8010P0000000000" }, "T8210P0000000001")).toBe("T8010P0000000000");
  });

  /**
   * An empty string is what the cloud sends for "no station", and treating it as a serial would group every
   * such device together under one imaginary station — the worst possible answer, because it looks valid.
   */
  it("treats an empty station field as absent rather than as a station", () => {
    expect(resolvedStationSn({ station_sn: "", parent_sn: "" }, "T8410P0000000002")).toBe("T8410P0000000002");
  });

  it("groups two cameras of one base together and keeps a standalone one apart", () => {
    const base = "T8010P0000000000";
    const grouped = [
      resolvedStationSn({ parent_sn: base }, "T8210P0000000001"),
      resolvedStationSn({ parent_sn: base }, "T8114P0000000003"),
      resolvedStationSn({}, "T8410P0000000002"),
    ];
    expect(grouped).toEqual([base, base, "T8410P0000000002"]);
  });
});
