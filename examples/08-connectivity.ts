/**
 * Example 08 — SDK-managed connectivity (battery-aware P2P + read cache).
 *
 * Connectivity is owned by the SDK. A successful `login()` brings up the event channels (push + MQTT)
 * on its own; P2P to a battery camera opens only when a command / stream / doorbell ring needs it and
 * detaches when idle. Reads are cached, so polling a device does not wake it. This example passes the
 * (optional) tuning knobs through `loginClient`, then shows that events + reads work with no extra
 * setup — leave it running so a doorbell ring pre-warms P2P for an instant live view.
 *
 *   EUFY_EMAIL=you@example.com EUFY_PASSWORD=… node examples/08-connectivity.ts
 *
 * Requires `npm run build` first (imports the built lib from ../dist).
 */
import { loginClient } from "./_client.ts";

async function main(): Promise<void> {
  // All optional — these are the defaults, shown for reference.
  const eufy = await loginClient({
    p2pIdleMs: 5 * 60_000, // battery station idle window before detach
    cacheTtlMs: 15_000, // freshness window for cached reads
    // doorbell + human/animal/object detections (default); raw "motion" excluded to protect battery
    prewarmEvents: ["doorbellPress", "personDetected", "petDetection", "packageDelivered"],
    prewarmMs: 28_000, // how long a pre-warmed session is held
  });

  eufy.on("error", (e) => console.error("error:", e.message));
  eufy.on("p2pConnect", (sn) => console.log("p2p open:", sn));
  eufy.on("p2pClose", (sn) => console.log("p2p closed (idle):", sn));
  eufy.on("doorbellPress", (e) => console.log("doorbell — pre-warming P2P for", e.deviceSn));
  eufy.on("personDetected", (e) => console.log("person — pre-warming P2P for", e.deviceSn));

  // Reads are served from cache — this loop does not wake a battery camera. The fluent
  // `dev.battery?.()?.level` getter is the typed twin of `getProperty("battery")?.value`: a
  // `number | undefined` (no manual narrowing), reading through the same cache.
  for (const d of await eufy.getDevices()) {
    const dev = await eufy.getDevice(d.sn);
    const level: number | undefined = dev.battery?.()?.level;
    console.log(`${d.name}: battery=${level ?? "—"}`);
  }

  console.log("listening — ring a doorbell to see the pre-warm; Ctrl-C to exit");
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
