import { detectCapabilities, CAPABILITY_MODULES } from "../index.js";
import type { Capability, Codec } from "../../types.js";

/**
 * The product-line partition: a capability may only land on a device from its own ecosystem.
 *
 * eufy's retail vocabulary collides across ecosystems that share nothing but a cloud account: the
 * T8L20 smart light is sold as "Outdoor Spotlights E10", which matches the camera-spotlight
 * capability's name hint exactly. Detection evidence is OR-ed and several capabilities match on NAME
 * alone, so the partition is what keeps a device from being handed a capability whose wire it cannot
 * speak.
 */

/** Which line each codec belongs to, restated here so a change to the source map has to be deliberate. */
const EXPECTED_LINE: Record<Codec, string> = {
  station: "security",
  camera: "security",
  sensor: "security",
  lock: "security",
  keypad: "security",
  vacuum: "clean",
  mower: "clean",
  light: "life",
  printer: "print",
  display: "security",
};

/** A name stuffed with trigger words from every line at once — the adversarial case. */
const POISONED = "Outdoor Spotlights Floodlight Waterfall Leak Smoke Carbon Siren Lock Safe Doorbell Vacuum";

const CODECS = Object.keys(EXPECTED_LINE) as Codec[];

function lineOf(cap: Capability): string {
  return CAPABILITY_MODULES[cap].line ?? "security";
}

describe("product-line partition", () => {
  it.each(CODECS)("never crosses lines on a %s, even with a name poisoned by every line's vocabulary", (codec) => {
    const caps = detectCapabilities(
      { model: "T8000P0000000000", category: "eufy_life", name: POISONED } as never,
      codec,
    );
    const crossed = caps.filter((c) => {
      const line = lineOf(c);
      return line !== "any" && line !== EXPECTED_LINE[codec];
    });
    expect(crossed).toEqual([]);
  });

  it("pins the display codec's actual exposure to a poisoned name, now that its line is security", () => {
    // The generic it.each above can't catch this: display's line IS security, so a poisoned-name match
    // against a security capability is no longer a "cross" by that test's own definition. This is the
    // real, current consequence of that grouping (a maintainer decision, not wire evidence — see
    // namespaceForCodec's doc comment): six security-line capabilities attach on adversarial name text
    // alone, none of them reachable (no P2P path exists for this device at all). The real device name
    // ("Eufy Smart Display" / "Smart Display E10") doesn't trigger any of this — see model.spec.ts's
    // display test — so it isn't a live problem today. Pinned so the day this SET changes (a security
    // module's modelHints starts matching different text, or a new one is added) is visible in CI
    // instead of silently passing, since `crossed` is `[]` either way.
    const caps = detectCapabilities({ model: "T87A0", category: "eufy_mega", name: POISONED } as never, "display");
    expect(caps).toEqual(["light", "doorbell", "leak", "smoke", "co", "lock", "info"]);
  });

  it("keeps a smart light off the camera-spotlight capability while granting its own", () => {
    const caps = detectCapabilities(
      { model: "T8L20", category: "eufy_life", name: "Outdoor Spotlights E10" } as never,
      "light",
    );
    expect(caps).toContain("smart_light");
    expect(caps).not.toContain("light");
    expect(caps).not.toContain("camera");
  });

  it("keeps a camera off the smart-light capability (the reverse direction)", () => {
    const caps = detectCapabilities(
      { model: "T8425", category: "eufy_security", name: "Floodlight Cam", params: { 1400: "1" } } as never,
      "camera",
    );
    expect(caps).toContain("light");
    expect(caps).not.toContain("smart_light");
  });

  it("blocks a life capability from a security codec even when its own evidence matches", () => {
    // Without the partition this passes on `codecs: ["light"]` alone, so the codec baseline is fed the
    // life value while the device is classified security — the one input that isolates the line check
    // from every other guard.
    expect(detectCapabilities({ model: "T8L02", category: "eufy_life" } as never, "light")).toContain("smart_light");
    expect(detectCapabilities({ model: "T8L02", category: "eufy_life" } as never, "sensor")).not.toContain(
      "smart_light",
    );
  });

  it("still grants a line-agnostic capability everywhere", () => {
    for (const codec of CODECS) {
      expect(detectCapabilities({ model: "T8000P0000000000" } as never, codec)).toContain("info");
    }
  });

  it("pins each non-security module's declared line, so a silent retag fails here", () => {
    // `lineOf` defaults to "security", so asserting membership of the union would pass for any module
    // that simply forgot to declare one. Pin the modules that must NOT be security instead.
    expect(CAPABILITY_MODULES.smart_light.line).toBe("life");
    expect(CAPABILITY_MODULES.vacuum_clean.line).toBe("clean");
    expect(CAPABILITY_MODULES.suction.line).toBe("clean");
    expect(CAPABILITY_MODULES.locate.line).toBe("clean");
    expect(CAPABILITY_MODULES.info.line).toBe("any");
    for (const cap of Object.keys(CAPABILITY_MODULES) as Capability[]) {
      expect(["security", "life", "clean", "print", "any"]).toContain(lineOf(cap));
    }
  });
});
