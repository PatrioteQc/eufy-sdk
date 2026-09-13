import { DISPLAY, DISPLAY_MEMBERS, DISPLAY_PARAM } from "../display.js";
import { detectCapabilities } from "../index.js";
import { DISPLAY_PARAMS, SECURITY_PARAMS } from "../../param-dictionary.js";
import { namespaceForCodec } from "../../param-namespace.js";
import type { ValueMember } from "../members.js";

/**
 * The Smart Display capability, and the two partitions that make it safe to have.
 *
 * The device is interesting for what it CANNOT do: no P2P path at all, six params in an id range no
 * other line uses, and three of those six illegible from one capture. So most of what is worth pinning
 * here is absence — that nothing was invented, and that nothing from another line can reach it.
 */
describe("display capability", () => {
  it("reports only the three params whose meaning the capture shows", () => {
    expect(Object.keys(DISPLAY_MEMBERS).sort()).toEqual(["modelCode", "modelName", "softwareVersion"]);
    expect(DISPLAY.properties?.map((p) => p.paramType).sort()).toEqual([8003, 8005, 8006]);
  });

  it("names no param whose meaning one value cannot settle", () => {
    // The device also reported 8001 ("100"), 8002 ("1") and 8004 (a serial-shaped string). `100` fits
    // brightness, volume or battery equally, `1` fits any flag, and a serial could be the display's or
    // its station's. A name for any of them would be read downstream as a fact, and on a screen device a
    // misread `100` shown as battery is the kind of wrong that looks right.
    for (const id of [8001, 8002, 8004]) {
      expect(DISPLAY_PARAMS[id]).toBeUndefined();
      expect(DISPLAY.properties?.some((p) => p.paramType === id)).toBe(false);
    }
  });

  it("offers no write at all, because no display write is captured", () => {
    // An AIoT write is fire-and-forget: the device acknowledges nothing, so a guessed frame looks
    // exactly like success. Read-only is the honest surface until a capture pins one.
    for (const [name, member] of Object.entries(DISPLAY_MEMBERS)) {
      const m = member as ValueMember;
      expect(m.write, `${name} has a write builder`).toBeUndefined();
      expect(m.writeAs, `${name} declares a setter name`).toBeUndefined();
    }
  });

  it("labels the version-shaped string as the guess it is", () => {
    // Its value was "2.9.05" on one device and nothing corroborates the mapping. The two identity reads
    // are `mega` because their VALUES were independently known facts — the retail name and the model
    // code — which is evidence about what the id means, not a shape that suggests it.
    expect((DISPLAY_MEMBERS.softwareVersion as ValueMember).provenance).toBe("guessed");
    expect((DISPLAY_MEMBERS.modelName as ValueMember).provenance).toBe("mega");
    expect((DISPLAY_MEMBERS.modelCode as ValueMember).provenance).toBe("mega");
  });

  it("reads its own id space, not the security dictionary", () => {
    // The grouping this replaces meant a future security param in the 8000s would have been decoded off
    // a Smart Display as something it is not. Both halves are asserted: the codec resolves here, and the
    // security table has no claim on these ids.
    expect(namespaceForCodec("display")).toBe("display");
    for (const id of Object.values(DISPLAY_PARAM)) {
      expect(SECURITY_PARAMS[id], `security params now claim ${id}`).toBeUndefined();
    }
  });

  it("attaches to a Smart Display that has reported nothing yet", () => {
    // By codec, not by an evidence param. A device on this line has no other capability to carry it, so
    // a unit that has not reported its params should still resolve as a display rather than as nothing.
    expect(detectCapabilities({ model: "T87A0", category: "eufy_mega" } as never, "display")).toContain("display");
  });

  it("stays off every other codec", () => {
    for (const codec of ["camera", "station", "sensor", "lock", "keypad", "vacuum", "mower", "light"] as const) {
      expect(detectCapabilities({ model: "T87A0", name: "Smart Display E10" } as never, codec)).not.toContain(
        "display",
      );
    }
  });
});
