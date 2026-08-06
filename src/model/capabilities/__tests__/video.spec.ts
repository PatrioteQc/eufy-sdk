import { VIDEO } from "../video.js";

describe("video capability module", () => {
  it("declares the capability + empty schema", () => {
    expect(VIDEO.capability).toBe("video");
    expect(Array.isArray(VIDEO.properties)).toBe(true);
    expect(VIDEO.properties).toEqual([]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of VIDEO.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("detects via the live-view enable param + camera codec", () => {
    expect(VIDEO.detection?.evidenceParams).toEqual([1056]);
    expect(VIDEO.detection?.codecs).toEqual(["camera"]);
  });
});
