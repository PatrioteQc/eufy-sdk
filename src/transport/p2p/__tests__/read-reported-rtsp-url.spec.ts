import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

const DEVICE_SN = "T8114P0000000000";
const STATION_SN = "T8010P0000000000";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";
const CMD_NAS_SWITCH = 1145;
const CMD_NAS_TEST = 1146;

interface FakeSession extends FakeP2PSession {
  sendIntStringCommand: ReturnType<typeof vi.fn>;
}

function setup(overrides: Partial<P2PRouterDeps> = {}) {
  const session = connectedSession() as FakeSession;
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
    rtspUrlReadTimeoutMs: 30,
    ...overrides,
  };
  const router = new P2PCommandRouter(deps);
  (router as unknown as { manager: { register(sn: string, value: unknown): void } }).manager.register(
    STATION_SN,
    session,
  );
  return { router, session };
}

/** One event-loop turn — enough for `resolveSession`'s already-registered fast path to settle. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("P2PCommandRouter.readReportedRtspUrl", () => {
  it("writes the publish switch then the livestream test, both for the resolved channel", async () => {
    const { router, session } = setup();
    const read = router.readReportedRtspUrl(DEVICE_SN);
    await tick();

    expect(session.sendIntStringCommand).toHaveBeenNthCalledWith(1, CMD_NAS_SWITCH, 1, 1, ACCOUNT_ID, 1);
    expect(session.sendIntStringCommand).toHaveBeenNthCalledWith(2, CMD_NAS_TEST, 1, 1, ACCOUNT_ID, 1);

    session.emit("rtspUrl", { channel: 1, url: "rtsp://u:p@host/live0" });
    await expect(read).resolves.toBe("rtsp://u:p@host/live0");
  });

  it("ignores a push for another channel on the same station session", async () => {
    const { router, session } = setup();
    const read = router.readReportedRtspUrl(DEVICE_SN);
    await tick();

    session.emit("rtspUrl", { channel: 2, url: "rtsp://wrong-camera/live0" });
    await tick(); // let the wait loop re-arm its listener before the next push arrives
    session.emit("rtspUrl", { channel: 1, url: "rtsp://right-camera/live0" });
    await expect(read).resolves.toBe("rtsp://right-camera/live0");
  });

  it("resolves undefined and leaves no listener behind when nothing answers in time", async () => {
    const { router, session } = setup({ rtspUrlReadTimeoutMs: 20 });

    await expect(router.readReportedRtspUrl(DEVICE_SN)).resolves.toBeUndefined();

    expect(session.listenerCount("rtspUrl"), "a timed-out read must not leave a listener on the station session").toBe(
      0,
    );
  });

  it("leaves no listener behind on the success path either", async () => {
    const { router, session } = setup();
    const read = router.readReportedRtspUrl(DEVICE_SN);
    await tick();

    session.emit("rtspUrl", { channel: 1, url: "rtsp://u:p@host/live0" });
    await read;

    expect(session.listenerCount("rtspUrl")).toBe(0);
  });
});
