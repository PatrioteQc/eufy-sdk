import { KEYPAD } from "../keypad.js";

describe("keypad capability module", () => {
  it("declares the capability + schema", () => {
    expect(KEYPAD.capability).toBe("keypad");
    expect(KEYPAD.properties.map((p) => p.name)).toEqual(["batteryLow", "charging", "rssi"]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of KEYPAD.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("is the keypad-codec baseline", () => {
    expect(KEYPAD.detection?.codecs).toEqual(["keypad"]);
  });
});
