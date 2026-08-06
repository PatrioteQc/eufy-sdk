import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * Every `storage` feature, declared once. All three ids are unconfirmed placeholders pending a live
 * capture/toggle-diff, and a fleet probe found none of them reported by any station today.
 *
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const STORAGE_MEMBERS = {
  /**
   * A `scalar` rather than a boolean because what 2010 carries is unknown — presence, health and a
   * format state would all fit the name, and picking one would be inventing a value space. `guessed`
   * id, unreported by any station probed so far, so the evidence gate normally leaves it uninstalled.
   */
  sdCard: {
    param: 2010,
    type: "number",
    kind: "scalar",
    provenance: "guessed",
    description: "SD-card config/state. UNVERIFIED: placeholder id pending verification.",
  },
  /**
   * Remaining capacity, in megabytes AS THE DEVICE REPORTS THEM — no conversion, since scaling a number
   * whose id is a `guessed` placeholder would be compounding a guess. Takes `property: "storageFree"`
   * because `free` alone is too generic for the device's flat property namespace.
   */
  free: {
    param: 1131,
    property: "storageFree",
    type: "number",
    unit: "MB",
    kind: "megabytes",
    provenance: "guessed",
    description: "Free storage. UNVERIFIED: placeholder id pending verification.",
  },
  /**
   * Installed capacity, the denominator to `free`, in the device's own megabytes. Same `guessed`
   * standing as its sibling — the pair is only meaningful together, so treat one being absent as both
   * being unavailable. Renamed to `storageTotal` in the flat property namespace for the same reason.
   */
  total: {
    param: 1132,
    property: "storageTotal",
    type: "number",
    unit: "MB",
    kind: "megabytes",
    provenance: "guessed",
    description: "Total storage. UNVERIFIED: placeholder id pending verification.",
  },
} as const satisfies Members;

/** Bound storage reads — the object returned by `dev.storage()`. Read-only. */
export type StorageActions = Surface<typeof STORAGE_MEMBERS>;

/**
 * `storage` — on-device storage (SD card / eMMC / HDD). All three ids are unconfirmed placeholders
 * pending a live capture/toggle-diff.
 */
export const STORAGE: CapabilityModule = {
  capability: "storage",
  description: "Local storage (SD card / eMMC / HDD) presence and capacity.",
  members: STORAGE_MEMBERS,
  properties: propertiesOf(STORAGE_MEMBERS),
  // Storage is a station-codec baseline (hubs own recordings).
  detection: { codecs: ["station"] },
};
