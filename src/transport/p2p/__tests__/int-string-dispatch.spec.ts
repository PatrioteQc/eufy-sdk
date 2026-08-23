import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

const DEVICE_SN = "T8114P0000000000";
const STATION_SN = "T8010P0000000000";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";

interface FakeSession extends FakeP2PSession {
  sendIntStringCommand: ReturnType<typeof vi.fn>;
}

function setup(accountId = ACCOUNT_ID, register = true) {
  const session = connectedSession() as FakeSession;
  session.sendIntStringCommand = vi.fn();
  const deps: P2PRouterDeps = {
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () => [
      {
        sn: DEVICE_SN,
        stationSn: STATION_SN,
        raw: { parent_sn: STATION_SN, device_channel: 1, member: { admin_user_id: accountId } },
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
  if (register) {
    (router as unknown as { manager: { register(sn: string, value: unknown): void } }).manager.register(
      STATION_SN,
      session,
    );
  }
  return { router, session };
}

describe("P2P int-plus-string command dispatch", () => {
  it("injects account identity and preserves the bound camera channel", async () => {
    const { router, session } = setup();

    await router.dispatchCommand(DEVICE_SN, {
      kind: "p2p-int-string",
      cmd: 1202,
      value: 10,
      valueSub: 1,
      channel: 1,
    });

    expect(session.sendIntStringCommand).toHaveBeenCalledWith(1202, 10, 1, ACCOUNT_ID, 1);
  });

  it("rejects missing account identity without sending", async () => {
    const { router, session } = setup("");

    await expect(
      router.dispatchCommand(DEVICE_SN, {
        kind: "p2p-int-string",
        cmd: 1202,
        value: 10,
        valueSub: 1,
        channel: 1,
      }),
    ).rejects.toThrow(/requires an account id/);
    expect(session.sendIntStringCommand).not.toHaveBeenCalled();
  });

  it("rejects session resolution failure without sending", async () => {
    const { router, session } = setup(ACCOUNT_ID, false);

    await expect(
      router.dispatchCommand(DEVICE_SN, {
        kind: "p2p-int-string",
        cmd: 1202,
        value: 10,
        valueSub: 1,
        channel: 1,
      }),
    ).rejects.toThrow(/no P2P (?:endpoint|session)/);
    expect(session.sendIntStringCommand).not.toHaveBeenCalled();
  });
});
