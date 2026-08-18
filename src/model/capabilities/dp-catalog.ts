/**
 * Per-SKU DP capability catalog — the parsed result of a `get_product_data_point` API call.
 *
 * The raw response shape from `get_product_data_point` is not yet confirmed from a live capture
 * (the `MegaHttpClient.getProductDataPoint` method returns `unknown` for this reason). The parser
 * here is maximally defensive: any field mismatch or missing key yields an empty catalog, and
 * capabilities fall back to their safe defaults. Once a live response is captured and the shape
 * confirmed, tighten the field names below and drop the unused branches.
 *
 * @module model/capabilities/dp-catalog
 */

/** The parsed DP capability catalog for one product SKU. */
export interface DpCatalog {
  /** DP ids present in this product's catalog. */
  readonly dpIds: ReadonlySet<number>;
  /**
   * For enum-type DPs: the valid integer values as declared in the catalog.
   * Absent for non-enum DPs (bool, raw, integer, string).
   */
  readonly enumRanges: ReadonlyMap<number, readonly number[]>;
}

/** Returned whenever the API call fails or the response shape is not recognised. */
export const EMPTY_DP_CATALOG: DpCatalog = {
  dpIds: new Set(),
  enumRanges: new Map(),
};

/**
 * Defensively parse a raw `get_product_data_point` response into a {@link DpCatalog}.
 *
 * Handles both known response variants:
 *  - `dp_id` (Tuya-native integer field) or `id` (alternate field name)
 *  - `values` as a plain `number[]` array, a JSON-stringified `"[0,1,2,3]"`, or a
 *    JSON-stringified `"{\"range\":[\"0\",\"1\",\"2\",\"3\"]}"` object
 *
 * Returns {@link EMPTY_DP_CATALOG} on any shape mismatch — never throws.
 */
export function parseDpCatalog(raw: unknown): DpCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_DP_CATALOG;
  const r = raw as Record<string, unknown>;
  const list = r.data_point_list;
  if (!Array.isArray(list) || list.length === 0) return EMPTY_DP_CATALOG;

  const dpIds = new Set<number>();
  const enumRanges = new Map<number, readonly number[]>();

  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;

    // DP id: try dp_id first, then id
    const rawId = e.dp_id ?? e.id;
    const dpId = typeof rawId === "number" ? rawId : typeof rawId === "string" ? parseInt(rawId, 10) : NaN;
    if (!Number.isFinite(dpId) || dpId <= 0) continue;

    dpIds.add(dpId);

    // For enum-type DPs, parse the valid integer values
    const type = typeof e.type === "string" ? e.type.toLowerCase() : "";
    if (type === "enum") {
      const range = parseEnumRange(e.values);
      if (range.length > 0) enumRanges.set(dpId, range);
    }
  }

  if (dpIds.size === 0) return EMPTY_DP_CATALOG;
  return { dpIds, enumRanges };
}

/** Parse the `values` field of an enum DP entry into an integer array. */
function parseEnumRange(values: unknown): readonly number[] {
  if (values === null || values === undefined) return [];
  // Plain array of numbers or numeric strings
  if (Array.isArray(values)) return toNumberArray(values);
  // JSON-stringified: "[0,1,2,3]" or "{\"range\":[\"0\",\"1\",\"2\",\"3\"]}"
  if (typeof values === "string") {
    try {
      const parsed: unknown = JSON.parse(values);
      if (Array.isArray(parsed)) return toNumberArray(parsed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.range)) return toNumberArray(obj.range);
      }
    } catch {
      // not valid JSON — ignore
    }
  }
  return [];
}

function toNumberArray(arr: unknown[]): readonly number[] {
  const result: number[] = [];
  for (const v of arr) {
    const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
    if (Number.isFinite(n)) result.push(n);
  }
  return result;
}
