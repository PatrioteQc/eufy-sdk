import { PERSON_DETECTION } from "../person-detection.js";
import { detectCapabilities } from "../index.js";

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

  it("advertises semantic person events on the camera baseline without inventing sensor support", () => {
    expect(detectCapabilities({ params: {} }, "camera")).toContain("person_detection");
    expect(detectCapabilities({ params: {} }, "sensor")).not.toContain("person_detection");
    expect(PERSON_DETECTION.events?.map(({ emit }) => emit)).toEqual([
      "personDetected",
      "personDetected",
      "strangerDetected",
    ]);
  });
});
