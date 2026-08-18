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
  it("T2268 → T218X (18) — confirmed integer from ICleanBridgeDeviceInterface.java", () => {
    expect(vacuumProductTypeFor("T2268")).toBe(VacuumProductType.T218X);
  });

  it("T-codes with unresolved type return undefined without fallback", () => {
    expect(vacuumProductTypeFor("T2278")).toBeUndefined();
    expect(vacuumProductTypeFor("T2750")).toBeUndefined();
    expect(vacuumProductTypeFor("T2770")).toBeUndefined();
    expect(vacuumProductTypeFor("T1240")).toBeUndefined();
  });

  it("T-codes with unresolved type return the fallback when supplied", () => {
    expect(vacuumProductTypeFor("T2278", VacuumProductType.X9)).toBe(VacuumProductType.X9);
    expect(vacuumProductTypeFor("T2750", VacuumProductType.L60)).toBe(VacuumProductType.L60);
  });

  it("fallback is also returned for a completely unknown model", () => {
    expect(vacuumProductTypeFor("T9999")).toBeUndefined();
    expect(vacuumProductTypeFor("T9999", VacuumProductType.G50)).toBe(VacuumProductType.G50);
  });

  it("fallback is NOT used when the type is already resolved (T2268)", () => {
    expect(vacuumProductTypeFor("T2268", VacuumProductType.X9)).toBe(VacuumProductType.T218X);
  });

  it("T1241 (EufyGenie speaker) is not in the map", () => {
    expect(vacuumProductTypeFor("T1241")).toBeUndefined();
  });

  it("VACUUM_PRODUCT_CODES contains all 5 confirmed vacuum T-codes", () => {
    expect(VACUUM_PRODUCT_CODES.size).toBe(5);
    expect(VACUUM_PRODUCT_CODES.get("T2268")).toBe(VacuumProductType.T218X);
    expect(VACUUM_PRODUCT_CODES.has("T2278")).toBe(true);
    expect(VACUUM_PRODUCT_CODES.has("T2750")).toBe(true);
    expect(VACUUM_PRODUCT_CODES.has("T2770")).toBe(true);
    expect(VACUUM_PRODUCT_CODES.has("T1240")).toBe(true);
    expect(VACUUM_PRODUCT_CODES.has("T1241")).toBe(false); // speaker, not a vacuum
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
