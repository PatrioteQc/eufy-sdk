/**
 * Anker Solix product catalog — the vendor's pairable-product registry (categories → products),
 * used to label a discovered device's model code with a marketing name + category.
 *
 * This is model-layer vocabulary: pure data shapes + a lookup builder, with no wire/transport
 * dependency. The catalog itself is fetched from the cloud by the client layer (`SolixClient`), which
 * feeds it here via {@link buildModelIndex}; keeping the shapes and the index in the model layer lets
 * `SolixDevice` resolve a name/category without reaching across the capability↔transport boundary.
 */

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

/**
 * Flatten a product catalog into a `product_code → { name, category }` lookup for labelling
 * discovered devices. Every variant code in `p_codes` maps to its parent product too, so a device
 * reporting a sub-model resolves to the same marketing name.
 */
export function buildModelIndex(categories: SolixProductCategory[]): Map<string, { name: string; category: string }> {
  const index = new Map<string, { name: string; category: string }>();
  for (const category of categories) {
    for (const product of category.products ?? []) {
      const entry = { name: product.name, category: category.name };
      if (product.product_code) index.set(product.product_code, entry);
      for (const variant of product.p_codes ?? []) {
        const code = typeof variant === "string" ? variant : (variant as { product_code?: string })?.product_code;
        if (code) index.set(code, entry);
      }
    }
  }
  return index;
}
