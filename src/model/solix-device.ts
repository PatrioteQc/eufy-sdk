/**
 * A capability-driven model for a discovered Anker Solix device — the Solix analogue of the eufy
 * `Device` model: ONE `SolixDevice` class, no per-model subclasses, and behaviour resolved from what
 * the device reports (its catalog category + record fields + live telemetry) rather than switched on
 * its model. Callers branch on {@link SolixDevice.has}(capability), never on the product code.
 *
 * The capabilities and their surface come from the SAME capability-module pattern the eufy model uses
 * ({@link SOLIX_MODULES} — `CapabilityModule<SolixCapability>`, one `members` table per feature), NOT a
 * hand-rolled parallel system: `energyMeter()`'s reads are derived by the shared `bindMembers` engine
 * and evidence-gated, so a getter exists only once a live frame has carried its tag. `identity` /
 * `firmware` / `connectivity` are read-only projections of the device record (like the eufy `info`
 * capability), so they take no telemetry and are always answerable when the record carries the field.
 */
import { bindMembers } from "./capabilities/members.js";
import type { CapabilityStateReader, CommandContext } from "./capabilities/types.js";
import type { CommandSink } from "../core/contracts.js";
import {
  detectSolixCapabilities,
  SOLIX_ENERGY_METER_MEMBERS,
  type SolixCapability,
  type SolixEnergyMeterReads,
} from "./capabilities/solix.js";
import { buildModelIndex } from "./solix-catalog.js";
import type { SolixDeviceRecord, SolixProductCategory } from "../core/solix-types.js";

// Re-exported for callers that import the record shape from the model surface (it lives in core so the
// transport client can return it without crossing the transport↔model line — see core/solix-types).
export type { SolixDeviceRecord } from "../core/solix-types.js";

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
 * The `dev.energyMeter()` handle: the members-derived reads ({@link SolixEnergyMeterReads} —
 * `meterVoltageL1` is present only once a frame carrying its tag has landed) plus the bespoke
 * `channels()`, which returns every decoded float keyed `channel_<hex tag>`. `channels()` is not a
 * member because a static members table cannot enumerate arbitrary dynamic hex tags; it is where every
 * not-yet-named meter quantity is read until its tag→name binding is confirmed.
 */
export type SolixEnergyMeter = SolixEnergyMeterReads & { channels(): Record<string, number> };

/** Options for {@link SolixDevice}. */
export interface SolixDeviceOptions {
  /** Catalog categories (from `SolixClient.getProductCatalog()`) — used to resolve name + category. */
  catalog?: SolixProductCategory[];
}

/** A no-op sink: Solix telemetry is read-only — no member here dispatches a command. */
const READ_ONLY_SINK: CommandSink = { dispatch: async () => {} };

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
    this.caps = detectSolixCapabilities(record, this.identity_.category);
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
    // Members-derived reads via the shared engine. The reads flip on live: bindMembers gates each getter
    // on `ctx.paramIds`, which is rebuilt each call from the tags this device has actually reported (the
    // `channel_<hex>` keys the decoder writes), so `meterVoltageL1` exists only once tag 0xAC has landed.
    const reads = bindMembers(SOLIX_ENERGY_METER_MEMBERS, this.meterDeps());
    return Object.assign(reads, { channels: () => this.telemetry() });
  }

  /** Minimal {@link MemberDeps} for the members engine: a read closure over the values store + the seen tags. */
  private meterDeps(): { ctx: CommandContext; sink: CommandSink; read: CapabilityStateReader } {
    // Reads `this.values` LIVE (not a captured snapshot): applyReading rebinds it, so a getter on a held
    // handle reflects a later reading. (Getter INSTALLATION is still gated on the evidence at bind time —
    // re-call energyMeter() to pick up a getter for a tag first seen after the handle was taken.)
    const read: CapabilityStateReader = (name) => {
      const v = this.values[name];
      return v === undefined ? undefined : { name, paramType: 0, value: v, ts: Date.now() };
    };
    // `codec` is required by CommandContext but is a pure eufy discriminator no Solix member consults —
    // pass a benign sentinel; it never leaves this internal context. paramIds is the evidence gate.
    const ctx: CommandContext = { codec: "sensor", channel: 0, paramIds: this.seenTags() };
    return { ctx, sink: READ_ONLY_SINK, read };
  }

  /** The ff09 tags this device has reported, derived from the decoder's `channel_<hex>` keys. */
  private seenTags(): ReadonlySet<number> {
    const tags = new Set<number>();
    for (const key of Object.keys(this.values)) {
      const m = /^channel_([0-9a-f]+)$/.exec(key);
      if (m) tags.add(parseInt(m[1], 16));
    }
    return tags;
  }
}

/**
 * The minimum a client must offer to be discovered against — the two wire reads {@link discoverSolixDevices}
 * composes. Typed STRUCTURALLY (not as `SolixClient`) so the model layer never imports the transport
 * client: the hard `transport ⊥ model` rule forbids it, and a structural shape needs no import.
 */
export interface SolixDeviceReader {
  getDevices(): Promise<SolixDeviceRecord[]>;
  getProductCatalog(): Promise<SolixProductCategory[]>;
}

/**
 * Discover an account's Solix devices as capability-driven {@link SolixDevice} objects — the wire+model
 * composition (a transport read + the product catalog) that used to be `SolixClient.discoverDevices()`.
 * It lives in the model layer because it builds `SolixDevice`; the wire client (now `transport/http`)
 * cannot, and passing it structurally keeps the layers decorrelated. Feed live telemetry to each result
 * via `SolixDevice.applyReading`.
 */
export async function discoverSolixDevices(
  client: SolixDeviceReader,
  opts: { catalog?: SolixProductCategory[] } = {},
): Promise<SolixDevice[]> {
  const [records, catalog] = await Promise.all([
    client.getDevices(),
    opts.catalog ? Promise.resolve(opts.catalog) : client.getProductCatalog().catch(() => [] as SolixProductCategory[]),
  ]);
  return records.map((r) => new SolixDevice(r, { catalog }));
}
