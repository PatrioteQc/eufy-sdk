import {
  isIndoorCamera,
  isIndoorCamMini,
  isIndoorPanTiltS350,
  isOutdoorPanTilt,
  isFloodLight,
  isWiredDoorbell,
  VacuumProductType,
  VACUUM_PRODUCT_CODES,
  vacuumProductTypeFor,
} from "../device-family.js";
import { DeviceType } from "../device-types.js";

const ctx = (deviceType?: number, model?: string) => ({ deviceType, model });

describe("VacuumProductType enum — integer values match ICleanBridgeDeviceInterface.java", () => {
  it("has the correct integer values for boundary and spot-check members", () => {
    expect(VacuumProductType.X9).toBe(0);
    expect(VacuumProductType.X10).toBe(1);
    expect(VacuumProductType.T218X).toBe(18);
    expect(VacuumProductType.C30_LITE).toBe(24);
    expect(VacuumProductType.S2_PRO).toBe(25);
  });

  it("has 26 distinct integer values (0–25)", () => {
    const values = Object.values(VacuumProductType).filter((v) => typeof v === "number") as number[];
    expect(values.length).toBe(26);
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(25);
    expect(new Set(values).size).toBe(26); // all distinct
  });
});

describe("vacuumProductTypeFor — product-code lookup", () => {
  it("T2268 → T218X (18) — only confirmed mapping from the decompile", () => {
    expect(vacuumProductTypeFor("T2268")).toBe(VacuumProductType.T218X);
  });

  it("returns undefined for an unknown model", () => {
    expect(vacuumProductTypeFor("T9999")).toBeUndefined();
  });

  it("T1241 (EufyGenie speaker) is not in the map", () => {
    expect(vacuumProductTypeFor("T1241")).toBeUndefined();
  });

  it("VACUUM_PRODUCT_CODES contains exactly the confirmed mappings", () => {
    expect(VACUUM_PRODUCT_CODES.size).toBe(1);
    expect(VACUUM_PRODUCT_CODES.get("T2268")).toBe(VacuumProductType.T218X);
  });
});

describe("device-family — classification", () => {
  it("isIndoorCamera covers indoor variants incl. PT / S350 / mini", () => {
    expect(isIndoorCamera(ctx(DeviceType.INDOOR_PT_CAMERA))).toBe(true); // 31 (T8410)
    expect(isIndoorCamera(ctx(DeviceType.INDOOR_COST_DOWN_CAMERA))).toBe(true); // mini
    expect(isIndoorCamera(ctx(DeviceType.INDOOR_PT_CAMERA_S350))).toBe(true);
    expect(isIndoorCamera(ctx(DeviceType.CAMERA2))).toBe(false); // 9 battery
    expect(isIndoorCamera(ctx(undefined))).toBe(false); // unknown → don't guess
  });

  it("mini / S350 / outdoor-PT / floodlight / doorbell predicates", () => {
    expect(isIndoorCamMini(ctx(DeviceType.INDOOR_COST_DOWN_CAMERA))).toBe(true);
    expect(isIndoorPanTiltS350(ctx(DeviceType.INDOOR_PT_CAMERA_S350))).toBe(true);
    expect(isIndoorPanTiltS350(ctx(DeviceType.INDOOR_PT_CAMERA))).toBe(false); // classic PT ≠ S350
    expect(isOutdoorPanTilt(ctx(DeviceType.OUTDOOR_PT_CAMERA))).toBe(true); // 48
    expect(isOutdoorPanTilt(ctx(DeviceType.SOLO_CAMERA_E30))).toBe(true); // 88
    expect(isFloodLight(ctx(DeviceType.FLOODLIGHT_CAMERA_8422))).toBe(true);
    expect(isWiredDoorbell(ctx(DeviceType.DOORBELL))).toBe(true); // 5
  });
});
