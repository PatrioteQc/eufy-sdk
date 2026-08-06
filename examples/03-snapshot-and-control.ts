/**
 * Example 03 — snapshot + fluent capability control.
 *
 * Resolves one device and drives it through the typed fluent API: grab a still, then (if the
 * device has the capability) power it on and pan-tilt. Accessors are `undefined` when the device
 * lacks the capability, so guard with `?.`.
 *
 * `snapshot()` returns a real still — the stored one, or a live-burst fallback (`file === ""` then) —
 * and is short-TTL cached + coalesced (tune with `{ cacheTtlMs }`). It throws a typed
 * `SnapshotUnavailableError` (not a falsy result) when none is obtainable; branch on `reason`
 * (`offline` vs `no-still`) and render your own placeholder — the SDK never returns placeholder bytes.
 *
 *   EUFY_EMAIL=… EUFY_PASSWORD=… node examples/03-snapshot-and-control.ts <serial>
 *
 * Requires `npm run build` first.
 */
import fs from "node:fs";
import { PtzDirection, SnapshotUnavailableError } from "../dist/index.js";
import { loginClient } from "./_client.ts";

async function main(): Promise<void> {
  const sn = process.argv[2];
  if (!sn) throw new Error("usage: node examples/03-snapshot-and-control.ts <serial>");

  const eufy = await loginClient();

  const dev = await eufy.getDevice(sn);

  const cam = dev.camera?.();
  // Media actions exist only when the device is bound to a live client (they are here) — the
  // method is optional on the type, so guard the method, not just the `camera()` accessor.
  try {
    const shot = await cam?.snapshot?.(); // pass { cacheTtlMs } to tune the poll cache; 0 = fresh
    if (shot) {
      fs.writeFileSync("snapshot.jpg", shot.jpeg);
      console.log("saved snapshot.jpg", shot.jpeg.length, "bytes", shot.file ? `(stored ${shot.file})` : "(live)");
    }
  } catch (e) {
    if (e instanceof SnapshotUnavailableError) console.log(`no snapshot available: ${e.reason}`);
    else throw e;
  }

  // Fluent control — the accessor is undefined if the device lacks the capability; confirm the
  // individual action exists before calling it too.
  if (typeof cam?.on === "function") await cam.on();
  const pt = dev.ptz?.();
  if (typeof pt?.rotate === "function") await pt.rotate(PtzDirection.left);
  console.log("done");

  await eufy.disconnect();
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
