import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

/**
 * Who owns the wait for a level-2 session key.
 *
 * The key belongs to the session, is negotiated once shortly after it connects, and every command that
 * needs it asks that same session. Resolving one therefore delegates the wait rather than running its own
 * clock: a per-call budget cannot tell a session that answered ten minutes ago from one still negotiating,
 * so it charges its full budget again on every call — a silent, fixed toll on each media egress and each
 * HomeBase-routed command, invisible in a log because nothing about it is reported.
 */
const DEVICE_SN = "T8000P0000000000";
const STATION_SN = "T8000P0000000001";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";

const SOFT_GRACE_MS = 8_000;
const HARD_GRACE_MS = 25_000;

interface FakeSession extends FakeP2PSession {
  sendSetPayload: ReturnType<typeof vi.fn>;
  sendRawLevel2: ReturnType<typeof vi.fn>;
  sendStringPayloadCommand: ReturnType<typeof vi.fn>;
  sendIntStringCommand: ReturnType<typeof vi.fn>;
}

function setup(hasLevel2Key: boolean) {
  const session = connectedSession(hasLevel2Key) as FakeSession;
  session.sendSetPayload = vi.fn();
  session.sendRawLevel2 = vi.fn(() => true);
  session.sendStringPayloadCommand = vi.fn();
  session.sendIntStringCommand = vi.fn();
  const deps: P2PRouterDeps = {
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () => [
      {
        sn: DEVICE_SN,
        stationSn: STATION_SN,
        raw: { parent_sn: STATION_SN, device_channel: 1, member: { admin_user_id: ACCOUNT_ID } },
      } as never,
    ],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  const router = new P2PCommandRouter(deps);
  (router as unknown as { manager: { register(sn: string, value: unknown): void } }).manager.register(
    STATION_SN,
    session,
  );
  return { router, session };
}

describe("resolving a session defers the level-2 wait to the session", () => {
  /**
   * A media egress asks best-effort, because only the HomeBase-attached path needs the key and a camera on
   * its own session legitimately never negotiates one. Best-effort has to mean "ask the session", or it
   * means "stall every stream on a camera that will never answer".
   */
  it("asks the session once, with the best-effort grace, and streams without a key", async () => {
    const { router, session } = setup(false);
    const source = await router.sharedLiveSourceFor(DEVICE_SN);
    expect(source).toBeDefined();
    expect(session.awaitLevel2Key).toHaveBeenCalledTimes(1);
    expect(session.awaitLevel2Key).toHaveBeenCalledWith(SOFT_GRACE_MS);
  });

  it("asks with the full grace where the key is a requirement", async () => {
    const { router, session } = setup(true);
    await router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 }).catch(() => {});
    expect(session.awaitLevel2Key).toHaveBeenCalledWith(HARD_GRACE_MS);
  });

  /** A requirement the session reports it cannot meet is a refusal now, not a wait that ends in one. */
  it("refuses a command that requires a key the session answers it will not have", async () => {
    const { router } = setup(false);
    await expect(router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 })).rejects.toThrow(/level-2 key not ready/);
  });

  /** Most commands ride level 1 and never need the key, so nothing may make them wait for it. */
  it("does not ask at all for a command that rides level one", async () => {
    const { router, session } = setup(false);
    await router.dispatchCommand(DEVICE_SN, { kind: "p2p-int-string", cmd: 1202, value: 10, valueSub: 1, channel: 1 });
    expect(session.awaitLevel2Key).not.toHaveBeenCalled();
  });
});
