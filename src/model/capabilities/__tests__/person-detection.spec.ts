import { PERSON_DETECTION } from "../person-detection.js";

describe("person_detection capability module", () => {
  it("declares the capability + schema", () => {
    expect(PERSON_DETECTION.capability).toBe("person_detection");
    expect(PERSON_DETECTION.properties.map((p) => p.name)).toEqual(["personDetection", "personDetected"]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of PERSON_DETECTION.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("has no detection (attached via registry, not self-detected)", () => {
    expect(PERSON_DETECTION.detection).toBeUndefined();
  });
});
