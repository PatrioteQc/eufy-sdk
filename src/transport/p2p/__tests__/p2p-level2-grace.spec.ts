import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

/**
 * Waiting for the level-2 session key, and why the wait belongs to the session rather than to each call.
 *
 * The key is negotiated once, from the station's `CMD_GATEWAYINFO` reply, right after the session
 * connects. Every command that needs it therefore asks the same question of the same session — so a wait
 * restarted per call spends its whole budget again on a session that answered long ago, or on one whose
 * negotiation already concluded that no key is coming. A station that never offers one turns that into a
 * fixed toll on every media call for the life of the session, which is not a latency any caller can see
 * or avoid.
 *
 * The session knows all three answers, so it is the only place that can give them without waiting.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const LEVEL2_KEY = Buffer.alloc(32, 7);

/** A gateway-info payload whose only read member is the leading `cipher_id`. */
function gatewayInfo(cipherId: number): Buffer {
  const payload = Buffer.alloc(64);
  payload.writeUInt16LE(cipherId, 0);
  return payload;
}

function session(resolveCipherKey?: (cipherId: number) => Promise<string | undefined>): P2PSession {
  const built = new P2PSession({
    stationSn: STATION_SN,
    p2pDid: P2P_DID,
    ...(resolveCipherKey ? { resolveCipherKey } : {}),
  });
  connectedAgo(built, 0);
  return built;
}

/** Pretend the session connected `ms` ago, which is when its negotiation had its chance to start. */
function connectedAgo(target: P2PSession, ms: number): void {
  (target as unknown as { connectedAtMs?: number }).connectedAtMs = Date.now() - ms;
}

function negotiate(target: P2PSession, cipherId = 3): void {
  (target as unknown as { negotiateLevel2Key(payload: Buffer): void }).negotiateLevel2Key(gatewayInfo(cipherId));
}

describe("level-2 key wait", () => {
  it("answers at once when the key is already negotiated", async () => {
    const target = session(async () => undefined);
    target.setLevel2Key(LEVEL2_KEY);
    await expect(target.awaitLevel2Key(25_000)).resolves.toBe(true);
  });

  /**
   * A station whose cipher has no key for this account will never produce one, and the negotiation is
   * one-shot — so every later wait is spent on an answer that cannot change.
   */
  it("answers at once once the negotiation concluded without a key", async () => {
    const target = session(async () => undefined);
    negotiate(target);
    await vi.waitFor(() => expect(target.hasLevel2Key).toBe(false));
    await expect(target.awaitLevel2Key(25_000)).resolves.toBe(false);
  });

  /** With no way to resolve a cipher key, the negotiation cannot even begin. */
  it("answers at once when nothing can negotiate a key at all", async () => {
    await expect(session().awaitLevel2Key(25_000)).resolves.toBe(false);
  });

  it("resolves as soon as a key arrives part-way through the grace", async () => {
    const target = session(async () => undefined);
    const waiting = target.awaitLevel2Key(25_000);
    setTimeout(() => target.setLevel2Key(LEVEL2_KEY), 10);
    await expect(waiting).resolves.toBe(true);
  });

  /**
   * The grace is the session's, measured from the connect that gave the negotiation its chance. A caller
   * arriving after it has elapsed has already missed it, so waiting again buys nothing.
   */
  it("spends nothing on a session whose grace has already elapsed", async () => {
    const target = session(async () => undefined);
    connectedAgo(target, 30_000);
    const started = Date.now();
    await expect(target.awaitLevel2Key(8_000)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("waits only for what is left of the grace", async () => {
    const target = session(async () => undefined);
    connectedAgo(target, 7_960);
    const started = Date.now();
    await expect(target.awaitLevel2Key(8_000)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /**
   * The negotiation needs a cloud round-trip for the station's cipher key, so it can still be in flight
   * long after the connect that prompted it. Anchoring the grace on connect alone would abandon a
   * negotiation that was about to succeed, which is the opposite failure to the one this all fixes.
   */
  it("still gives a negotiation that began late its own grace", async () => {
    const target = session(() => new Promise<string | undefined>(() => {}));
    connectedAgo(target, 30_000);
    negotiate(target);
    const started = Date.now();
    await expect(target.awaitLevel2Key(40)).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  /** A session that never connected has not had its chance yet, so the whole grace is still ahead of it. */
  it("gives an unconnected session its full grace", async () => {
    const target = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, resolveCipherKey: async () => undefined });
    const started = Date.now();
    await expect(target.awaitLevel2Key(40)).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
});
