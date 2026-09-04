/**
 * LAN-address resolution for a P2P station from its cloud device record.
 *
 * Pure helpers (no session state) — used when opening a P2P session to prefer a direct on-LAN
 * lookup over the cloud relay (works when broadcast is blocked by AP isolation / macOS, even if
 * the record's pairing `ip_addr` went stale).
 */

/** True for an RFC-1918 private IPv4 (a routable LAN address, not a WAN/public one). */
export function isPrivateIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((o) => Number(o) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Resolve the freshest LAN IP for a station from its cloud record.
 *
 * The record carries the device IP in several places of differing trust:
 *  - **params** (`{param_type, param_value, update_time}`) — self-reported by the device on each
 *    heartbeat, so a private-IP param value is timestamped and updates when the device roams.
 *  - **`ip_addr`** (top-level) — frozen at pairing, no timestamp; goes stale if the device moved
 *    to another subnet since (observed live: a SoloCam still advertising a 192.168.86.x pairing
 *    address while actually on 192.168.1.x).
 *  - **`local_ip`** — often empty, or the public WAN address.
 *
 * Strategy: collect every param whose value is a private IPv4, take the one with the newest
 * `update_time`, and only fall back to `ip_addr` / `local_ip` when no param IP exists. This
 * prefers the most recent evidence over a fixed field-priority order.
 */
export function freshestLanIp(raw: unknown): string | undefined {
  const rec = raw as
    | { params?: Array<{ param_value?: unknown; update_time?: unknown }>; ip_addr?: unknown; local_ip?: unknown }
    | undefined;
  let best: { ip: string; ts: number } | undefined;
  for (const p of rec?.params ?? []) {
    const v = typeof p?.param_value === "string" ? p.param_value : undefined;
    if (!v || !isPrivateIpv4(v)) continue;
    const ts = typeof p.update_time === "number" ? p.update_time : 0;
    if (!best || ts > best.ts) best = { ip: v, ts };
  }
  if (best) return best.ip;
  for (const cand of [rec?.local_ip, rec?.ip_addr]) {
    if (typeof cand === "string" && isPrivateIpv4(cand)) return cand;
  }
  return undefined;
}

/**
 * The RTSP URL a device itself reported into its cloud record, or `undefined` when none is there.
 *
 * The vendor app keeps referring to "the device-reported URL" as the thing NAS storage is verified
 * against, which implies the device publishes one — the open question (see the publish switch,
 * `CMD_NAS_STREAM_SWITHC` 1145, and its read-only neighbour `CMD_NAS_TEST_STREAM` 1146) is where.
 * Params the device volunteers land in the cloud record with timestamps, the same channel
 * {@link freshestLanIp} mines for addresses — so until a live read of 1146 is captured, the record
 * is the one place a reported URL could already be sitting. This scans every string param for an
 * `rtsp://` URL and returns the newest; a consumer should treat it as a HINT to verify (a
 * `DESCRIBE` costs one round trip), not an address to trust blindly, exactly like the record's IPs.
 */
export function reportedRtspUrl(raw: unknown): string | undefined {
  const rec = raw as
    | {
        params?: Array<{ param_value?: unknown; update_time?: unknown }> | Record<number | string, string>;
        paramUpdatedAt?: Record<number | string, number>;
        dpParams?: Record<number | string, string>;
      }
    | undefined;
  // The device's own realtime report outranks every cloud snapshot: `dpParams` is what the station
  // volunteered over its live wire, which is where a just-regenerated URL lands first — the cloud
  // copy follows on the device's own schedule.
  for (const value of Object.values(rec?.dpParams ?? {})) {
    if (typeof value !== "string" || !value.includes("rtsp://")) continue;
    const m = /rtsp:\/\/[^\s"'\\,}]+/.exec(value);
    if (m) return m[0];
  }
  // Both param shapes a caller holds: the cloud record's own `{param_type, param_value,
  // update_time}` array, and the registry's merged `DeviceRecord` (`params` as id → value with
  // `paramUpdatedAt` beside it) — the latter is what a read-through per-device fetch returns, i.e.
  // the FRESH copy, which matters here because the vendor app regenerates the URL's embedded
  // credentials on every publish toggle and a stale roster keeps serving the previous pair.
  const entries: Array<{ value: unknown; ts: number }> = Array.isArray(rec?.params)
    ? rec.params.map((p) => ({
        value: p?.param_value,
        ts: typeof p?.update_time === "number" ? p.update_time : 0,
      }))
    : Object.entries(rec?.params ?? {}).map(([id, value]) => ({
        value,
        ts: rec?.paramUpdatedAt?.[id] ?? 0,
      }));
  let best: { url: string; ts: number } | undefined;
  for (const { value, ts } of entries) {
    if (typeof value !== "string" || !value.includes("rtsp://")) continue;
    const m = /rtsp:\/\/[^\s"'\\,}]+/.exec(value);
    if (!m) continue;
    if (!best || ts > best.ts) best = { url: m[0], ts };
  }
  return best?.url;
}
