import { STORAGE } from "../storage.js";

describe("storage capability module", () => {
  it("declares the capability + schema", () => {
    expect(STORAGE.capability).toBe("storage");
    expect(STORAGE.properties.map((p) => p.name)).toEqual(["sdCard", "storageFree", "storageTotal"]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of STORAGE.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("is a station-codec baseline", () => {
    expect(STORAGE.detection?.codecs).toEqual(["station"]);
  });
});
