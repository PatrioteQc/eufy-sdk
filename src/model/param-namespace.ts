/**
 * Param namespaces — which id space a device's reported `paramType`s live in.
 *
 * The three spaces overlap numerically and mean unrelated things, so a lookup MUST be namespaced: id
 * `163` is `battery` as a vacuum Tuya DP and `lightLength` as a `eufy_life` DP tag. Resolving a param
 * without its namespace is how one product line's state silently reads as another's.
 *
 * This lives outside `param-dictionary.ts` so the namespace union and the dispatch stay one small table
 * a reader can hold at once, next to the guard that a codec resolves to exactly one namespace — rather
 * than at the head of two thousand entries.
 *
 * @module model/param-namespace
 */
import type { Codec } from "./types.js";
import { SECURITY_PARAMS, CLEAN_PARAMS, type ParamDef } from "./param-dictionary.js";
import { LIFE_PARAMS } from "./life-params.js";

/** The param id spaces this SDK models. */
export type ParamNamespace = "security" | "clean" | "life" | "print";

const TABLES: Record<ParamNamespace, Record<number, ParamDef>> = {
  security: SECURITY_PARAMS,
  clean: CLEAN_PARAMS,
  life: LIFE_PARAMS,
  // 3D-printer (ankermake) id space — empty until a live capture confirms the param↔semantic map
  // (printer-support plan Stage 3). Present so the printer codec resolves to its OWN namespace rather
  // than falling through to `security` and decoding another line's dictionary.
  print: {},
};

/** Look up a param def in the given namespace. */
export function paramDef(ns: ParamNamespace, paramType: number): ParamDef | undefined {
  return TABLES[ns][paramType];
}

/**
 * The param namespace each codec's ids live in — the one place that mapping is made, so the model and
 * the inspector can't disagree about how to read a device's params. Exhaustive over {@link Codec} on
 * purpose: a new codec is a **compile error** here rather than a silent fall-through to `security`
 * (which would read another line's dictionary — e.g. a mower's Tuya DPs decoded as security params,
 * mislabelling the security battery id on a device where it means nothing).
 *
 * `mower` shares the **clean** namespace: it's a Clean-line Tuya-DP device (the app's `TuyaP2PMower`
 * family), so its DPs live in the same `~150-180` space as the vacuums.
 *
 * `display` (the T87Ax Smart Display line) is placed in **`security`** by maintainer decision, not wire
 * evidence — the confirmed transport is secure MQTT with no `p2p_did`, never P2P, and its own params
 * (8001-8006) don't presently exist in `SECURITY_PARAMS`. Grouping it here means (a) a future security
 * param assigned in that id range would silently misdecode against this device, and (b) any security
 * capability whose `modelHints` regex matches this device's reported name/model text becomes
 * inference-attachable — the exact `T8L20`-as-"Outdoor Spotlights" collision this partition otherwise
 * guards against, now possible for `display` too. Measured, not hypothetical: with an adversarial name
 * (see `line-partition.spec.ts`'s `POISONED` case) six security capabilities currently attach this way;
 * the real device's actual reported name doesn't trigger any of them today (see `model.spec.ts`'s
 * display test), so this isn't a live problem, only an open door — flagged here so a future reader
 * doesn't mistake either the grouping or its current quiet outcome for evidence that it's safe.
 */
const NAMESPACE_BY_CODEC: Record<Codec, ParamNamespace> = {
  station: "security",
  camera: "security",
  sensor: "security",
  lock: "security",
  keypad: "security",
  vacuum: "clean",
  mower: "clean",
  light: "life",
  printer: "print",
  display: "security",
};

/** The param namespace a device's ids live in, from its codec, via the module-local `NAMESPACE_BY_CODEC` table. */
export function namespaceForCodec(codec: Codec): ParamNamespace {
  return NAMESPACE_BY_CODEC[codec];
}
