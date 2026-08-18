/**
 * Device-family **classification** — the single home for the one question "what product family is
 * this device?" (indoor cam, mini, S350 pan/tilt, outdoor pan/tilt, floodlight, wired doorbell, …),
 * a set of pure predicates over the vendor `DeviceType`.
 *
 * These predicates are PURE and param-agnostic: they answer family membership only. The per-param
 * *semantics* a family implies — 1035 enable-bit vs disable-bit polarity, the 1400 light-switch
 * frame shape — deliberately do NOT live here; each capability composes those from these predicates
 * (see `capabilities/camera.ts` `isEnableBitPolarity`, `capabilities/light.ts` `lightSwitchWire`).
 * And the P2P encryption LEVEL (L1 vs L2) is not a family trait at all: it is a runtime *topology*
 * fact (standalone vs HomeBase-attached) resolved at send time in the transport. Keeping this file
 * classification-only is what lets one predicate be reused across capabilities without dragging a
 * param id or a wire form along with it.
 *
 * ## Detection is mega-only — no legacy fallback
 * The legacy cloud backend is frozen (a stub) and cannot identify equipment. Classification here
 * keys **exclusively** off the mega-resolved record: the vendor `deviceType` that
 * {@link module:model/capabilities.CommandContext} already carries from the mega `algo_ecdh` device
 * list. When `deviceType` is absent/unknown we DO NOT guess: predicates return `false`, so a
 * capability composing on them falls back to its safe default rather than mis-classifying the device.
 *
 * @module model/device-family
 */
import { DeviceType } from "./device-types.js";

/** The evidence a family decision needs — a structural subset of `CommandContext`. */
export interface FamilyContext {
  /** eufy vendor DeviceType, when known (undefined ⇒ unknown ⇒ don't guess). */
  deviceType?: number;
  /** Model / T-code, when known. */
  model?: string;
  /**
   * API category string — e.g. `"eufy_home"`, `"eufy_home_tuya"`, `"eufy_security"`. Supplied by
   * the mega `get_devs_list` response; absent in unit-test contexts that build a minimal context
   * without a real API record. Used as the PRIMARY transport discriminator for the clean line:
   * `"eufy_home_tuya"` devices are on the ThingClips/Tuya Cloud platform, not Anker AIoT MQTT.
   */
  category?: string;
}

// ── DeviceType sets ─────────────────────────────────────────────────────────────────────────────

/** Indoor cams, incl. indoor pan/tilt + S350/E30/C-series + mini. */
export const INDOOR_CAMERA_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.INDOOR_CAMERA,
  DeviceType.INDOOR_CAMERA_1080,
  DeviceType.INDOOR_PT_CAMERA,
  DeviceType.INDOOR_PT_CAMERA_1080,
  DeviceType.INDOOR_OUTDOOR_CAMERA_1080P,
  DeviceType.INDOOR_OUTDOOR_CAMERA_1080P_NO_LIGHT,
  DeviceType.INDOOR_OUTDOOR_CAMERA_2K,
  DeviceType.INDOOR_COST_DOWN_CAMERA,
  DeviceType.INDOOR_PT_CAMERA_S350,
  DeviceType.INDOOR_PT_CAMERA_E30,
  DeviceType.INDOOR_PT_CAMERA_C210,
  DeviceType.INDOOR_PT_CAMERA_C220,
  DeviceType.INDOOR_PT_CAMERA_C220_V2,
]);

/** Indoor pan/tilt S350 family. */
export const INDOOR_PT_S350_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.INDOOR_PT_CAMERA_S350,
  DeviceType.INDOOR_PT_CAMERA_E30,
  DeviceType.INDOOR_PT_CAMERA_C210,
  DeviceType.INDOOR_PT_CAMERA_C220,
  DeviceType.INDOOR_PT_CAMERA_C220_V2,
]);

/** Outdoor pan/tilt + solo-PT. */
export const OUTDOOR_PT_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.OUTDOOR_PT_CAMERA,
  DeviceType.SOLO_CAMERA_E30,
  DeviceType.CAMERA_S4,
  DeviceType.SOLOCAM_E42,
  DeviceType.CAMERA_4G_S330,
]);

/** Floodlight cams. */
export const FLOODLIGHT_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.FLOODLIGHT,
  DeviceType.FLOODLIGHT_CAMERA_8422,
  DeviceType.FLOODLIGHT_CAMERA_8423,
  DeviceType.FLOODLIGHT_CAMERA_8424,
  DeviceType.FLOODLIGHT_CAMERA_8425,
  DeviceType.FLOODLIGHT_CAMERA_8426,
]);

/** Wall-light cams. */
export const WALL_LIGHT_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.WALL_LIGHT_CAM,
  DeviceType.WALL_LIGHT_CAM_81A0,
]);

/**
 * HomeBase-family hubs — the station-class devices with a built-in **speaker + alarm siren**, so
 * they own the hub-audio surface (alarm / voice-prompt volume). A deliberate SUBSET of the `station`
 * codec that EXCLUDES the NVRs (S4 Max, PoE NVR): those resolve to `station` for arming/storage but
 * have no speaker, so they must NOT expose the hub-audio controls (they'd fire at nothing). The
 * alarm/prompt wire is verified on HomeBase 3 (HB3); the other hubs share the hub hardware.
 */
export const HOMEBASE_TYPES: ReadonlySet<number> = new Set<number>([
  DeviceType.STATION,
  DeviceType.HB3,
  DeviceType.MINIBASE_CHIME,
  DeviceType.HOMEBASE_MINI,
]);

// ── Family predicates ───────────────────────────────────────────────────────────────────────────

const has = (set: ReadonlySet<number>, t: number | undefined): boolean => t !== undefined && set.has(t);

/** Indoor camera (any indoor variant). */
export const isIndoorCamera = (ctx: FamilyContext): boolean => has(INDOOR_CAMERA_TYPES, ctx.deviceType);
/** Indoor cost-down "mini" cam. */
export const isIndoorCamMini = (ctx: FamilyContext): boolean => ctx.deviceType === DeviceType.INDOOR_COST_DOWN_CAMERA;
/** Indoor pan/tilt S350 family. */
export const isIndoorPanTiltS350 = (ctx: FamilyContext): boolean => has(INDOOR_PT_S350_TYPES, ctx.deviceType);
/** Outdoor pan/tilt (+ solo-PT) family. */
export const isOutdoorPanTilt = (ctx: FamilyContext): boolean => has(OUTDOOR_PT_TYPES, ctx.deviceType);
/** Floodlight cam family. */
export const isFloodLight = (ctx: FamilyContext): boolean => has(FLOODLIGHT_TYPES, ctx.deviceType);
/** HomeBase-family hub (has a speaker/alarm) — a station EXCLUDING the NVRs, per `HOMEBASE_TYPES`. */
export const isHomeBase = (ctx: FamilyContext): boolean => has(HOMEBASE_TYPES, ctx.deviceType);
/** Wired doorbell (DeviceType.DOORBELL). */
export const isWiredDoorbell = (ctx: FamilyContext): boolean => ctx.deviceType === DeviceType.DOORBELL;

// ── Vacuum product-type classification ──────────────────────────────────────────────────────────

/**
 * Integer product-family constants for the clean line, sourced verbatim from
 * `ICleanBridgeDeviceInterface.java` (`PRODUCT_TYPE_*`) in `eufy_decompiled` v6.0.41.
 *
 * These integers gate per-model capability restrictions (e.g. which ModeCtrl methods a model
 * supports). The values are read-only classification data — no write path depends on them.
 */
export enum VacuumProductType {
  X9 = 0,
  X10 = 1,
  G50 = 2,
  X8_PRO = 3,
  L50 = 4,
  L60 = 5,
  C20 = 6,
  S1 = 7,
  RACCOON = 8,
  E20 = 9,
  X8 = 10,
  G40 = 11,
  G35 = 12,
  G32_PRO = 13,
  G30 = 14,
  C10 = 15,
  E28 = 16,
  E25 = 17,
  T218X = 18,
  G20 = 19,
  S2 = 20,
  C28 = 21,
  E35 = 22,
  C30 = 23,
  C30_LITE = 24,
  S2_PRO = 25,
}

/**
 * All known vacuum product-code (T-code) → `VacuumProductType` mappings, covering every model
 * in the device registry. Sources:
 *  - `ICleanBridgeDeviceInterface.java` (`PRODUCT_CODE_*`) in `eufy_decompiled` v6.0.41 for
 *    the five decompile-confirmed entries (T2268 confirmed integer; T2278/T2750/T2770/T1240
 *    confirmed as codes but type integer unresolved).
 *  - Registry product names for all remaining models: types inferred by matching the model name
 *    against the `VacuumProductType` family names (e.g. "G40" → `G40`, "X10" → `X10`). Models
 *    whose family has no matching enum member carry `undefined`.
 *
 * Map presence distinguishes "known vacuum, type unresolved" from "unknown model entirely" so
 * `vacuumProductTypeFor` can return the caller's `fallback` instead of `undefined` for the
 * former. Mowers (T280B, T2801, T2880) and T1241 (EufyGenie speaker) are intentionally excluded.
 */
export const VACUUM_PRODUCT_CODES: ReadonlyMap<string, VacuumProductType | undefined> = new Map([
  // ── Decompile-confirmed PRODUCT_CODE_* entries ─────────────────────────────────────────────
  ["T2268", VacuumProductType.T218X], // L60 Hybrid — integer confirmed in ICleanBridgeDeviceInterface.java
  ["T2278", undefined], // L60 Hybrid SES — code confirmed; type integer unresolved
  ["T2750", undefined], // code confirmed; type integer unresolved
  ["T2770", undefined], // code confirmed; type integer unresolved
  ["T1240", undefined], // code confirmed; type integer unresolved

  // ── X-series ────────────────────────────────────────────────────────────────────────────────
  ["T2351", VacuumProductType.X10], // Clean X10 Pro Omni
  ["T2320", VacuumProductType.X9], // X9 Pro
  ["T2266", VacuumProductType.X8_PRO], // X8 Pro
  ["T2276", VacuumProductType.X8_PRO], // X8 Pro SES
  ["T2262", VacuumProductType.X8], // X8
  ["T2261", VacuumProductType.X8], // X8 Hybrid

  // ── L-series ────────────────────────────────────────────────────────────────────────────────
  ["T2267", VacuumProductType.L60], // L60
  ["T2277", VacuumProductType.L60], // L60 SES
  ["T2190", undefined], // L70 Hybrid — L70 has no VacuumProductType member

  // ── G-series ────────────────────────────────────────────────────────────────────────────────
  ["T2210", VacuumProductType.G50], // G50
  ["T2273", VacuumProductType.G40], // G40 Hybrid+
  ["T2256", VacuumProductType.G40], // G40 Hybrid
  ["T2255", VacuumProductType.G40], // G40
  ["T2270", VacuumProductType.G35], // G35+
  ["T2254", VacuumProductType.G35], // G35
  ["T2259", VacuumProductType.G32_PRO], // G32
  ["T2272", VacuumProductType.G30], // G30+ SES
  ["T2253", VacuumProductType.G30], // G30 Hybrid
  ["T2252", VacuumProductType.G30], // G30 Verge
  ["T2251", VacuumProductType.G30], // G30
  ["T2250", VacuumProductType.G30], // G30
  ["T2258", VacuumProductType.G20], // G20 Hybrid
  ["T2257", VacuumProductType.G20], // G20

  // ── C-series ────────────────────────────────────────────────────────────────────────────────
  ["T211A", VacuumProductType.C28], // C28
  ["T2280", VacuumProductType.C20], // C20
  ["T2292", VacuumProductType.C10], // C10

  // ── E-series ────────────────────────────────────────────────────────────────────────────────
  ["T2352", VacuumProductType.E28], // E28
  ["T2353", VacuumProductType.E25], // E25
  ["T2070", VacuumProductType.E20], // 3-in-1 E20

  // ── S-series ────────────────────────────────────────────────────────────────────────────────
  ["T2080", VacuumProductType.S1], // S1
  ["T2081", VacuumProductType.S2], // S2

  // ── LR-series — no matching VacuumProductType member ────────────────────────────────────────
  ["T2194", undefined], // LR35 Hybrid
  ["T2193", undefined], // LR30 Hybrid
  ["T2182", undefined], // LR35 Hybrid+
  ["T2181", undefined], // LR30 Hybrid+
  ["T2192", undefined], // LR20

  // ── Legacy RoboVac (G10, pre-G20 letter-series, numbered) ───────────────────────────────────
  ["T2150", undefined], // G10 Hybrid — G10 has no VacuumProductType member
  ["T2132", undefined], // RoboVac 25C
  ["T2130", undefined], // RoboVac 30C MAX
  ["T2128", undefined], // RoboVac 15C MAX
  ["T2123", undefined], // RoboVac 25C
  ["T2120", undefined], // RoboVac 15C MAX
  ["T2119", undefined], // RoboVac 11S
  ["T2118", undefined], // RoboVac 30C
  ["T2117", undefined], // RoboVac 35C
  ["T2103", undefined], // RoboVac 11C
  ["T1250", undefined], // RoboVac 35C (T1xxx prefix, pre-T2 numbering)
]);

/**
 * Look up the `VacuumProductType` for a vacuum's product-model string (T-code).
 *
 * Three outcomes:
 *  - Model is in the map **with a resolved type** → returns that type.
 *  - Model is in the map **with `undefined`** (T-code confirmed, type unresolved) → returns
 *    `fallback` when supplied, otherwise `undefined`.
 *  - Model is **not in the map** (unknown) → returns `fallback` when supplied, otherwise
 *    `undefined`.
 *
 * Capabilities composing on this MUST treat `undefined` as "unknown" and fall back to their
 * safe default, never guess a type.
 */
export function vacuumProductTypeFor(model: string, fallback?: VacuumProductType): VacuumProductType | undefined {
  if (VACUUM_PRODUCT_CODES.has(model)) {
    return VACUUM_PRODUCT_CODES.get(model) ?? fallback;
  }
  return fallback;
}

/**
 * Whether a vacuum uses the **Anker AIoT MQTT** transport (modern DP 150–180 protobuf scheme).
 *
 * A **negative exclusion**: returns `false` only for the one confirmed non-AIoT platform
 * (`"eufy_home_tuya"` — ThingClips/Tuya Cloud). Any absent, unknown, or unrecognised category
 * defaults to `true`, matching the polarity of `routeCommand` which sends `aiot-dp` to MQTT
 * unless `category === "eufy_home_tuya"`. The two gates now agree: an unknown-category AIoT
 * vacuum both routes to MQTT *and* has its setters installed.
 *
 * | `category`          | platform                           | returns |
 * | ------------------- | ---------------------------------- | ------- |
 * | `"eufy_home"`       | Anker AIoT MQTT ✅ confirmed       | `true`  |
 * | `"eufy_home_tuya"`  | ThingClips/Tuya Cloud ✅ confirmed  | `false` |
 * | absent / any other  | unknown — default to AIoT          | `true`  |
 *
 * Live-confirmed categories sourced from `get_devs_list` dumps: `"eufy_home_tuya"` from a T2266
 * X8 Pro (2026-08-04). Additional category strings are added here as devices are captured.
 */
export const isAiotVacuum = (ctx: FamilyContext): boolean => ctx.category !== "eufy_home_tuya";

/**
 * Whether a vacuum is on the **ThingClips/Tuya Cloud** platform (`"eufy_home_tuya"` category).
 *
 * The positive complement of the negative-exclusion {@link isAiotVacuum}: returns `true` only for
 * the one confirmed non-AIoT platform. Used to extend capability `available` guards so Tuya
 * vacuums receive the same write actions as AIoT ones, routed by the facade's `routeCommand`.
 */
export const isTuyaVacuum = (ctx: FamilyContext): boolean => ctx.category === "eufy_home_tuya";
