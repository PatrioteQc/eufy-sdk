/**
 * Anker **Solix** capability modules — the SAME capability-module pattern the eufy device model uses,
 * parameterised on Solix's own id union via {@link CapabilityModule}<{@link SolixCapability}>. Not a
 * second capability system: the property schema, the evidence-gated getters and the descriptions all
 * derive from one `members` table through the shared engine (`members.ts` `bindMembers`/`propertiesOf`),
 * exactly as a eufy capability does.
 *
 * Solix is a separate ecosystem (its own Anker account + backend), so it keeps its own id union and its
 * own registry ({@link SOLIX_MODULES}) rather than joining eufy's `Capability`/`Codec` unions — every
 * module declares `line: "solix"` so the product-line partition covers it. Detection is by Anker catalog
 * CATEGORY + product-code prefix (see {@link detectSolixCapabilities}), not eufy param ids, so the
 * modules here carry the surface (members), while detection lives in the Solix-scoped resolver.
 *
 * @module model/capabilities/solix
 */
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/** Every capability a Solix device may carry. Solix's OWN union (not eufy's `Capability`). */
export type SolixCapability =
  | "identity"
  | "firmware"
  | "connectivity"
  | "energyMeter"
  | "battery"
  | "solarInput"
  | "acOutput"
  | "evCharger"
  | "charger"
  | "cooler";

/** A Solix capability module — the eufy module contract, parameterised on {@link SolixCapability}. */
export type SolixCapabilityModule = CapabilityModule<SolixCapability>;

/**
 * The `energyMeter` surface, declared once. Only the ONE confirmed tag→name binding is a member:
 * `meterVoltageL1` (ff09 tag `0xAC`), confirmed against a live single-phase frame. The evidence gate
 * (`bindMembers` + `reads`) installs its getter only once a frame carrying tag `0xAC` has landed and
 * answers `undefined` before — so the "undefined until a real frame" fact the old hand-written comment
 * spelled out is now stated by construction.
 *
 * The meter reports many more quantities (per-line power/current/voltage, totals, import/export energy),
 * but their tag→name bindings are a structural inference not yet pinned to a known-load capture. Rather
 * than assert a name that could mislabel a live float, those stay reachable raw as `channel_<hex>` via
 * the bespoke `channels()` method on the bound surface (a static members table cannot enumerate dynamic
 * hex tags); each is promoted to a member here, one line, as a capture confirms its binding.
 */
export const SOLIX_ENERGY_METER_MEMBERS = {
  /**
   * Line-1 voltage (V), ff09 tag `0xAC` — the ONE confirmed meter binding, matched against a live
   * single-phase frame (a nominal mains voltage). Read-only; the evidence gate installs its getter only
   * once a frame carrying `0xAC` has landed, so it is absent (not a fabricated `0`) until then.
   */
  meterVoltageL1: {
    param: 0xac,
    type: "number",
    kind: "scalar",
    unit: "V",
    provenance: "verified",
    description: "Meter line-1 voltage (V) — ff09 tag 0xAC, confirmed against a live single-phase frame.",
  },
} as const satisfies Members;

/** Bound `energyMeter` reads (the members-derived half of `dev.energyMeter()`). Read-only. */
export type SolixEnergyMeterReads = Surface<typeof SOLIX_ENERGY_METER_MEMBERS>;

/** A detection-only module: `has(cap)` is correct, but it carries no members, so no getter can exist. */
function detectionOnly(capability: SolixCapability, description: string): SolixCapabilityModule {
  return { capability, description, line: "solix", properties: [] };
}

/**
 * The Solix module registry — Solix-scoped, never joined to eufy's `CAPABILITY_MODULES`. `energyMeter`
 * carries the one confirmed members table; the rest are detection-only until a telemetry frame for that
 * family is captured and its fields confirmed (then they gain members, one line each).
 */
export const SOLIX_MODULES: Readonly<Record<SolixCapability, SolixCapabilityModule>> = {
  identity: detectionOnly("identity", "Device identity (serial, product code, resolved name/category)."),
  firmware: detectionOnly("firmware", "Reported firmware version."),
  connectivity: detectionOnly("connectivity", "Wi-Fi connectivity (online, rssi, ssid)."),
  energyMeter: {
    capability: "energyMeter",
    description: "Grid/energy-meter live readings (Smart Meter AE1X0).",
    line: "solix",
    members: SOLIX_ENERGY_METER_MEMBERS,
    properties: propertiesOf(SOLIX_ENERGY_METER_MEMBERS),
  },
  battery: detectionOnly("battery", "Battery/energy storage (Solarbank / power station)."),
  solarInput: detectionOnly("solarInput", "Solar PV input."),
  acOutput: detectionOnly("acOutput", "AC output."),
  evCharger: detectionOnly("evCharger", "EV charger."),
  charger: detectionOnly("charger", "Charger."),
  cooler: detectionOnly("cooler", "Powered cooler."),
};

/**
 * The capabilities each Anker catalog category implies. Category is a detection SIGNAL (like eufy's
 * `deviceTypes`), not the model's identity — a device still resolves `energyMeter` from telemetry/model
 * even though its category is "Accessory". Unlisted categories contribute nothing here.
 */
export const CATEGORY_CAPABILITIES: Readonly<Record<string, readonly SolixCapability[]>> = {
  "Portable Power Station": ["battery", "acOutput", "solarInput"],
  "Plug-in Home Battery": ["battery", "solarInput", "acOutput", "energyMeter"],
  "Powered Cooler": ["battery", "cooler"],
  "Power Bank": ["battery"],
  "Smart EV Charger": ["evCharger"],
  Charger: ["charger"],
  Accessory: [], // device-specific — the smart meter resolves energyMeter from telemetry/model below
};

/** Product-code prefixes known to be grid/energy meters (detects `energyMeter` regardless of category). */
export const SOLIX_METER_MODELS: readonly string[] = ["AE1X0"];

/**
 * Product-code prefixes for the grid-tie Solarbank / home-battery family (detects `battery` +
 * `solarInput` regardless of category): A1790 = Solarbank E1600 gen-1, A17C* = Solarbank 2 / 3.
 */
export const SOLARBANK_MODELS: readonly string[] = ["A1790", "A17C"];

/** The minimum device shape {@link detectSolixCapabilities} reads. */
export interface SolixDetectionInput {
  product_code: string;
  device_sw_version?: string;
  wifi_online?: boolean;
  wifi_name?: string;
  rssi?: string | number;
}

/**
 * Resolve a Solix device's capability set from its record fields, catalog category, and product-code
 * prefix — the Solix analogue of eufy's `detectCapabilities`, kept Solix-scoped so eufy detection is
 * untouched. `identity` is universal; the rest are OR-ed evidence.
 */
export function detectSolixCapabilities(rec: SolixDetectionInput, category?: string): Set<SolixCapability> {
  const caps = new Set<SolixCapability>(["identity"]);
  if (rec.device_sw_version) caps.add("firmware");
  if (rec.wifi_online !== undefined || rec.rssi != null || rec.wifi_name) caps.add("connectivity");
  for (const c of (category && CATEGORY_CAPABILITIES[category]) || []) caps.add(c);
  if (SOLIX_METER_MODELS.some((m) => rec.product_code?.startsWith(m))) caps.add("energyMeter");
  if (SOLARBANK_MODELS.some((m) => rec.product_code?.startsWith(m))) {
    caps.add("battery");
    caps.add("solarInput");
  }
  return caps;
}
