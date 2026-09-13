/**
 * The real app's MQTT `client_id` shape. `SecureMqtt` defaults to `clientId = thing_name =
 * "{uid}-{appName}"`, a completely different shape; some broker-side behavior may key off this string
 * (session/ACL tracking), so anything trying to look like the real app for reachability testing should
 * use this builder instead of the SDK default.
 *
 * Shape, with a redacted sample:
 * `android-eufy_security-0000000000000000000000000000000000000000-a7115bb62400710b-1784124496`
 * — the trailing segment is a plain connect-time Unix timestamp. One reading of the app appends a
 * dash-stripped endpoint address there instead; the two disagree and were never reconciled. This
 * builder follows the timestamp form, the one that actually earned a granted SUBSCRIBE.
 */
import { createHash, randomBytes } from "node:crypto";

export interface AppClientIdInput {
  /** Topic scope, e.g. "eufy_security". */
  appName: string;
  /** The logged-in user id (40-hex) — NOT necessarily the device owner if it's a shared device. */
  uid: string;
  /** Stable per-install identifier (`AIOTDeviceSdk.getMqttUUID()` on the real app). Any stable 16-hex
   * string works for our purposes — generate once and persist it, don't re-randomize per connect. */
  mqttUuid: string;
  /** Connect-time unix SECONDS. Defaults to now; inject for deterministic tests. */
  timestamp?: number;
}

/** Build a client_id shaped like `android-{appName}-{uid}-{mqttUuid}-{timestamp}`. */
export function buildAppShapedClientId(input: AppClientIdInput): string {
  const ts = input.timestamp ?? Math.floor(Date.now() / 1000);
  return `android-${input.appName}-${input.uid}-${input.mqttUuid}-${ts}`;
}

/** A fresh stable-looking install UUID (16 hex chars) — generate ONCE per identity and persist it
 * (a new random value on every connect defeats the point of "stable"). */
export function generateMqttUuid(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Derive a STABLE install UUID (16 hex chars) deterministically from a seed — the same lazy trick
 * `SolixClient` uses for `openudid`. Unlike {@link generateMqttUuid} this needs no storage: the same
 * seed always yields the same UUID, so the broker sees one stable client across restarts. Use a seed
 * distinct from any other derived id (a salt prefix) so the values don't collide.
 *
 * It separates two clients exactly as far as their seed does. The seeds available on these lines are
 * per-ACCOUNT (a user id, or `openudid` = `md5("anker-solix:" + email)`), so two clients seeded the same
 * way on one account derive the SAME uuid and collide at the broker (one evicts the other). Where more
 * than one client shares an account, seed this with something per-host/per-install, not the account id.
 */
export function deriveMqttUuid(seed: string): string {
  return createHash("md5").update(seed).digest("hex").slice(0, 16);
}
