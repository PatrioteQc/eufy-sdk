import { describe, it, expect, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import type { P2PRouterDeps } from "../command-router.js";

/**
 * `P2PCommandRouter.ensureStation`'s `resolveCipherKey` closure (the level-2 key negotiator handed to
 * `P2PSession`) — verifies a failed `get_ciphers()` call does NOT get cached, so a later invocation
 * (a later signCode-2/8 frame on the same long-lived session) retries instead of permanently returning
 * the poisoned `undefined`. Mirrors `detect_local_ip.spec.ts`'s "does NOT poison the cache" pattern for
 * a different cache with the same failure-mode bug.
 *
 * `P2PSession` is mocked to a bare `EventEmitter` (no real socket/connect) purely to capture the
 * `resolveCipherKey` callback passed to its constructor — the callback under test is the router's own
 * code, not anything session-internal.
 */
let capturedResolveCipherKey: ((cipherId: number) => Promise<string | undefined>) | undefined;

vi.mock("../p2p-session.js", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeP2PSession extends EventEmitter {
    isConnected = true;
    hasLevel2Key = false;
    constructor(opts: { resolveCipherKey: (cipherId: number) => Promise<string | undefined> }) {
      super();
      capturedResolveCipherKey = opts.resolveCipherKey;
    }
    connect = vi.fn(async () => {});
  }
  return { P2PSession: FakeP2PSession };
});

const { P2PCommandRouter } = await import("../command-router.js");

const DEVICE: EufyDevice = {
  sn: "T8531K0000000000",
  model: "T8531",
  category: "eufy_security",
  deviceClass: "camera",
  api: "mega",
  realtime: "p2p",
  p2pDid: "XXXXXXX-000000-XXXXX",
  raw: { member: { admin_user_id: "0".repeat(40) } },
};

function makeDeps(getCiphers: ReturnType<typeof vi.fn>): P2PRouterDeps {
  return {
    mega: {
      auth: { userId: "u1", authToken: "t" },
      getDskKeys: vi.fn().mockResolvedValue({}),
      getCiphers,
    } as unknown as P2PRouterDeps["mega"],
    listDevices: () => [DEVICE],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
}

describe("P2PCommandRouter.ensureStation — resolveCipherKey cache", () => {
  it("does NOT cache a failed get_ciphers() call — the next resolve retries and can succeed", async () => {
    const getCiphers = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce([{ cipher_id: 97, ecc_private_key: "deadbeef" }]);
    const router = new P2PCommandRouter(makeDeps(getCiphers));

    await router.ensureStation(DEVICE.sn);
    expect(capturedResolveCipherKey).toBeDefined();

    const first = await capturedResolveCipherKey!(97);
    expect(first).toBeUndefined(); // transient failure

    const second = await capturedResolveCipherKey!(97);
    expect(second).toBe("deadbeef"); // retried, not short-circuited on a poisoned cache entry

    expect(getCiphers).toHaveBeenCalledTimes(2);
  });

  it("DOES cache a successful get_ciphers() call — a later resolve does not re-fetch", async () => {
    const getCiphers = vi.fn().mockResolvedValue([{ cipher_id: 97, ecc_private_key: "cafebabe" }]);
    const router = new P2PCommandRouter(makeDeps(getCiphers));

    await router.ensureStation(DEVICE.sn);
    expect(await capturedResolveCipherKey!(97)).toBe("cafebabe");
    expect(await capturedResolveCipherKey!(97)).toBe("cafebabe");
    expect(getCiphers).toHaveBeenCalledTimes(1); // second resolve served from cache
  });
});
