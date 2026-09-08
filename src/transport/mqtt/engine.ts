/**
 * The MQTT engine, loaded on first use rather than at import.
 *
 * `mqtt` costs **+19 MB of RSS** to import — measured one fresh process per module, because a single
 * process importing several in sequence gives meaningless per-module deltas — which is over half of
 * what importing this package cost at all (+33 MB over a bare node; +25 after this). Every consumer
 * paid it at module load, including the ones whose accounts have no appliance to talk MQTT to: the
 * secure broker is only reached when a device needs it, and a camera-only account never opens one.
 *
 * So the import moves to the two places that actually dial a broker. Both already return promises, so
 * nothing about their contracts changes — an `await` in front of a network connect is not a cost.
 *
 * The promise is memoized, not the module: a second caller during the first load waits on the same
 * import rather than starting another, and a failed load is not cached as a failure.
 */
import type mqtt from "mqtt";

/** The `mqtt` module shape, loaded on demand. */
type Mqtt = typeof mqtt;
let enginePromise: Promise<Mqtt> | undefined;

/** Memoized lazy import of the MQTT engine — the ONLY runtime reference to `mqtt` in this package. */
export async function loadMqtt(): Promise<Mqtt> {
  if (!enginePromise) {
    enginePromise = import("mqtt").then(
      (m) => (m.default ?? m) as Mqtt,
      (e) => {
        // Do not leave a rejected promise memoized: a transient failure would then be permanent for
        // the life of the process, and the next connect attempt deserves a real one.
        enginePromise = undefined;
        throw e;
      },
    );
  }
  return await enginePromise;
}
