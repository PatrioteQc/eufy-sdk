/**
 * Anker Solix vendor-JSON record shapes — the cross-layer contract between the transport client (which
 * RETURNS them off the wire) and the model layer (which resolves them into `SolixDevice`). They live in
 * `core` for the same reason the command/media boundary does: the hard `transport ⊥ model` rule forbids
 * either layer importing the other, so a type both need is neither's to own.
 *
 * @module core/solix-types
 */

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

/** One product in the pairable-product catalog. Extra vendor fields (images, guides) are preserved. */
export interface SolixProduct {
  /** SKU / model code, e.g. `A1782`. */
  product_code: string;
  /** Marketing name, e.g. `SOLIX F3000`. */
  name: string;
  /** Variant/sub-model codes under this product, when present. */
  p_codes?: unknown[];
  [k: string]: unknown;
}

/** A catalog category (e.g. "Portable Power Station") and its products. */
export interface SolixProductCategory {
  name: string;
  products: SolixProduct[];
  [k: string]: unknown;
}

/** One device's membership entry within a site, as carried by `get_site_list`'s `site_device_list`. */
export interface SolixSiteDeviceEntry {
  device_sn: string;
  /** The device's product/model code (the site list names this field `device_model`). */
  device_model: string;
  device_name?: string;
  /** Anker device-type discriminator (e.g. 3 = Solarbank/battery, 6 = smart meter). */
  device_type?: number;
  [k: string]: unknown;
}

/**
 * A site ("system") record, as returned by `SolixClient.getSites()`. A site is the account's home
 * energy system — the "My Home" the app shows — grouping the member devices ({@link site_device_list})
 * that a {@link SolixSiteReader} resolves into a `SolixSite`. Extra vendor fields are preserved.
 */
export interface SolixSiteRecord {
  site_id: string;
  site_name?: string;
  /** Anker's site-type discriminator (e.g. 20 for a Solarbank-anchored home system). */
  power_site_type?: number;
  site_device_list?: SolixSiteDeviceEntry[];
  [k: string]: unknown;
}
