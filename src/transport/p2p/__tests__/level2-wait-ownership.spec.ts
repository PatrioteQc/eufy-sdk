import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

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

function setup(hasLevel2Key: boolean, attached = true) {
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
        stationSn: attached ? STATION_SN : DEVICE_SN,
        raw: {
          ...(attached ? { parent_sn: STATION_SN } : {}),
          device_channel: 1,
          member: { admin_user_id: ACCOUNT_ID },
        },
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
    attached ? STATION_SN : DEVICE_SN,
    session,
  );
  return { router, session };
}

/**
 * The key belongs to one connection of the session, is negotiated once from its gateway-info reply, and
 * every operation that needs it asks that session. Best-effort media uses one grace per session because it
 * can proceed without the key; a command that cannot be framed without the key owns a per-call grace.
 */
describe("resolving a session defers the level-2 wait to the session", () => {
  /**
   * A camera on its own session asks best-effort, because it legitimately never negotiates a key and its start
   * carries both levels. Best-effort has to mean "ask the session", or it means "stall every stream on a camera
   * that will never answer".
   */
  it("asks the session once, with the best-effort grace, for a camera on its own session", async () => {
    const { router, session } = setup(false, false);
    const source = await router.sharedLiveSourceFor(DEVICE_SN);
    expect(source).toBeDefined();
    expect(session.awaitLevel2Key).toHaveBeenCalledTimes(1);
    expect(session.awaitLevel2Key).toHaveBeenCalledWith(SOFT_GRACE_MS, "session");
  });

  /**
   * An attached camera's start has no level-1 form, so best-effort was the wrong ask for it: the send returns
   * without putting anything on the wire, and the warm-up then re-issues that nothing every interval until it
   * times out. Measured on a real account as 48 starts with no key, one keyframe between them, and a
   * `source-error` at the end.
   */
  it("refuses an attached camera's source where the session reports no key", async () => {
    const { router } = setup(false);
    await expect(router.sharedLiveSourceFor(DEVICE_SN)).rejects.toThrow(/level-2 key not ready/);
  });

  it("hands over an attached camera's source once the key is held", async () => {
    const { router } = setup(true);
    await expect(router.sharedLiveSourceFor(DEVICE_SN)).resolves.toBeDefined();
  });

  it("asks with the full grace where the key is a requirement", async () => {
    const { router, session } = setup(true);
    await router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 }).catch(() => {});
    expect(session.awaitLevel2Key).toHaveBeenCalledWith(HARD_GRACE_MS, "call");
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

/**
 * A command that cannot be framed without the key gets ONE more ask before being refused.
 *
 * The negotiation is one-shot per connection, so a gateway reply that never landed otherwise refuses every
 * later such command on that connection, although a fresh session over the same device negotiates a key
 * normally: measured, a settled session refused every level-2-only operation until it was rebuilt, at which
 * point the station answered with a cipher id straight away.
 */
describe("a required level-2 key is asked for twice before refusing", () => {
  it("proceeds when the station answers the second ask", async () => {
    const { router, session } = setup(false);
    session.keyArrivesOnReprompt = true;

    await expect(router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 })).rejects.not.toThrow(/level-2 key not ready/);

    expect(session.repromptLevel2Key).toHaveBeenCalledTimes(1);
    expect(session.awaitLevel2Key).toHaveBeenCalledTimes(2);
  });

  it("still refuses when there is no second ask to be had", async () => {
    const { router, session } = setup(false);

    await expect(router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 })).rejects.toThrow(/level-2 key not ready/);

    expect(session.repromptLevel2Key).toHaveBeenCalledTimes(1);
  });

  it("never re-prompts a session that already holds a key", async () => {
    const { router, session } = setup(true);

    await router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 }).catch(() => {});

    expect(session.repromptLevel2Key).not.toHaveBeenCalled();
  });
});
