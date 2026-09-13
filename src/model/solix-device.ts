/**
 * A capability-driven model for a discovered Anker Solix device — the Solix analogue of the eufy
 * `Device` model: ONE `SolixDevice` class, no per-model subclasses, and behaviour resolved from what
 * the device reports (its catalog category + record fields + live telemetry) rather than switched on
 * its model. Callers branch on {@link SolixDevice.has}(capability), never on the product code.
 *
 * Grounding: `identity`, `firmware`, `connectivity`, and `energyMeter` expose typed accessors backed
 * by data we can read today. `energyMeter` names only the ONE meter field confirmed against a live ff09
 * frame (`meterVoltageL1`); every other decoded tag is reachable raw via `channels()`, and a named
 * accessor is added per field once a known-load capture pins its tag→name binding. Every other
 * capability (`battery`, `solarInput`, `acOutput`, `evCharger`,
 * `charger`, `cooler`) is DETECTED so `has(...)` is correct, but carries NO typed value accessors: no
 * telemetry frame has been captured for those families, and there is no decode path emitting their
 * fields, so a typed getter could only ever return `undefined`. Callers use `has(cap)` +
 * {@link SolixDevice.telemetry} (raw decoded channels), and per-field accessors get added together with
 * a decoder once a real frame lands.
 */
import { buildModelIndex, type SolixProductCategory } from "./solix-catalog.js";

/** Every capability a Solix device may carry. `has(...)` gates each; only some have value accessors. */
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

/**
 * The capabilities each Anker catalog category implies. Category is a detection SIGNAL (like eufy's
 * `deviceTypes`), not the model's identity — a device still resolves `energyMeter` from telemetry even
 * though its category is "Accessory". Unlisted categories contribute nothing here and rely on
 * telemetry/model detection.
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

/** A discovered Solix device record, as returned by `SolixClient.getDevices()`. */
export interface SolixDeviceRecord {
  device_sn: string;
  product_code: string;
  device_name?: string;
  alias_name?: string;
  device_sw_version?: string;
  wifi_online?: boolean;
  wifi_name?: string;
  rssi?: string | number;
  [k: string]: unknown;
}

export interface SolixIdentity {
  serial: string;
  productCode: string;
  /** Friendly name — the catalog marketing name if resolvable, else the record's alias/name. */
  name: string;
  /** Anker catalog category (e.g. "Accessory", "Portable Power Station"), if resolvable. */
  category?: string;
}
export interface SolixConnectivity {
  online: boolean;
  rssi?: number;
  ssid?: string;
}
/**
 * Grid/energy-meter live values (Smart Meter AE1X0). Only `meterVoltageL1` is exposed as a named
 * accessor: its tag→name binding is confirmed against a live ff09 frame (`SOLIX_METER_FIELD_NAMES`).
 * The meter reports many more quantities (per-line power/current/voltage, totals, import/export energy),
 * but their tag→name bindings are a structural inference from the app's field list, not yet pinned to a
 * known-load capture — so rather than assert a name that could mislabel a live float, they are left
 * reachable raw via {@link channels} (keyed `channel_<hex tag>`). A named accessor is added per field,
 * one line each, as captures confirm each binding.
 */
export interface SolixEnergyMeter {
  /** Latest L1 line voltage (V) — the one confirmed meter field. */
  meterVoltageL1(): number | undefined;
  /** Every decoded float channel from the latest reading, keyed `channel_<hex tag>` (+ any named ones).
   * This is where every not-yet-named meter quantity is read until its binding is confirmed. */
  channels(): Record<string, number>;
}

/** Options for {@link SolixDevice}. */
export interface SolixDeviceOptions {
  /** Catalog categories (from `SolixClient.getProductCatalog()`) — used to resolve name + category. */
  catalog?: SolixProductCategory[];
}

/**
 * A discovered Solix device with resolved category + capabilities. Feed live telemetry with
 * {@link applyReading} (from {@link SolixMqtt}'s `reading` events) to populate value accessors.
 */
export class SolixDevice {
  readonly serial: string;
  readonly productCode: string;
  readonly record: SolixDeviceRecord;
  private readonly caps: Set<SolixCapability>;
  private readonly identity_: SolixIdentity;
  private values: Record<string, number> = {};

  constructor(record: SolixDeviceRecord, opts: SolixDeviceOptions = {}) {
    this.record = record;
    this.serial = record.device_sn;
    this.productCode = record.product_code;
    const label = opts.catalog ? buildModelIndex(opts.catalog).get(record.product_code) : undefined;
    this.identity_ = {
      serial: record.device_sn,
      productCode: record.product_code,
      name: label?.name ?? record.alias_name ?? record.device_name ?? record.product_code,
      category: label?.category,
    };
    this.caps = resolveCapabilities(record, this.identity_.category);
  }

  /** All capabilities this device carries. */
  get capabilities(): SolixCapability[] {
    return [...this.caps];
  }

  /** Whether the device carries a capability — the only correct way to branch on behaviour. */
  has(capability: SolixCapability): boolean {
    return this.caps.has(capability);
  }

  /**
   * Merge a live telemetry reading (a `SolixMqtt` `reading` event) so accessors reflect it. Takes the
   * WHOLE reading, not just its values, and drops one addressed to a different device: the documented
   * wiring is `mqtt.on("reading", r => device.applyReading(r))`, and one MQTT stream carries every
   * watched meter on the account — so without this filter two meters would cross-feed each other's floats.
   * A reading with no `deviceSn` (a hand-built one) is accepted as-is.
   */
  applyReading(reading: { deviceSn?: string; values: Record<string, number> }): void {
    if (reading.deviceSn && reading.deviceSn !== this.serial) return;
    this.values = { ...this.values, ...reading.values };
  }

  /** All decoded float telemetry channels from the latest applied reading (raw, `channel_<tag>` keys). */
  telemetry(): Record<string, number> {
    return { ...this.values };
  }

  identity(): SolixIdentity {
    return { ...this.identity_ };
  }

  firmware(): { version: string } | undefined {
    return this.record.device_sw_version ? { version: this.record.device_sw_version } : undefined;
  }

  connectivity(): SolixConnectivity | undefined {
    if (!this.has("connectivity")) return undefined;
    const rssi = this.record.rssi != null ? Number(this.record.rssi) : undefined;
    return {
      online: !!this.record.wifi_online,
      rssi: Number.isFinite(rssi) ? rssi : undefined,
      ssid: this.record.wifi_name,
    };
  }

  energyMeter(): SolixEnergyMeter | undefined {
    if (!this.has("energyMeter")) return undefined;
    // The accessors read through `this.values` (NOT a captured snapshot): `applyReading` rebinds that
    // field, so a handle held across a reading must see the new object, not the one present at call time.
    // The decoder (solixReadings) already writes each mapped tag under its named key — SOLIX_METER_FIELD_NAMES
    // in the decoder is the single source of truth for the names.
    return {
      meterVoltageL1: () => this.values.meterVoltageL1,
      channels: () => this.telemetry(), // same raw channel map as telemetry(), under the meter handle
    };
  }
}

/** Resolve a device's capability set from its record fields, catalog category, and model. */
function resolveCapabilities(record: SolixDeviceRecord, category?: string): Set<SolixCapability> {
  const caps = new Set<SolixCapability>(["identity"]);
  if (record.device_sw_version) caps.add("firmware");
  if (record.wifi_online !== undefined || record.rssi != null || record.wifi_name) caps.add("connectivity");
  for (const c of (category && CATEGORY_CAPABILITIES[category]) || []) caps.add(c);
  if (SOLIX_METER_MODELS.some((m) => record.product_code?.startsWith(m))) caps.add("energyMeter");
  if (SOLARBANK_MODELS.some((m) => record.product_code?.startsWith(m))) {
    caps.add("battery");
    caps.add("solarInput");
  }
  return caps;
}
