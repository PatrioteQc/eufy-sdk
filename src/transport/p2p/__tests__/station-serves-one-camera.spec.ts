import { describe, expect, it } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";
import { StationBusyError } from "../../../core/contracts.js";

/**
 * A station fans several cameras over one session and serves ONE of them at a time.
 *
 * Accepting a pull per camera did not make it serve two: measured on a base carrying three attached cameras,
 * each opened stream took the station from the others in turn and all three received their media in bursts. So
 * a second channel is refused, naming the one that holds the station.
 *
 * The SDK reports the constraint and does not rank the callers. Which camera deserves the station depends on
 * what a person is looking at and on what the host is able to show at once, which differ per ecosystem, so
 * nothing is queued and nothing is pre-empted. A caller releases the stream it no longer wants and asks again.
 */
const STATION_SN = "T8010P0000000000";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";
const DOORBELL = "T8210P0000000002";
const SIBLING = "T8114P0000000000";
const SOLO_A = "T8400P0000000000";
const SOLO_B = "T8410P0000000000";

function router() {
  const session = connectedSession(true) as FakeP2PSession;
  const deps: P2PRouterDeps = {
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () =>
      [
        {
          sn: DOORBELL,
          stationSn: STATION_SN,
          raw: { parent_sn: STATION_SN, device_channel: 2, member: { admin_user_id: ACCOUNT_ID } },
        },
        {
          sn: SIBLING,
          stationSn: STATION_SN,
          raw: { parent_sn: STATION_SN, device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
        },
        { sn: SOLO_A, stationSn: SOLO_A, raw: { device_channel: 0, member: { admin_user_id: ACCOUNT_ID } } },
        { sn: SOLO_B, stationSn: SOLO_B, raw: { device_channel: 0, member: { admin_user_id: ACCOUNT_ID } } },
      ] as never,
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  const built = new P2PCommandRouter(deps);
  const manager = (built as unknown as { manager: { register(sn: string, v: unknown): void } }).manager;
  for (const sn of [STATION_SN, SOLO_A, SOLO_B]) manager.register(sn, session);
  return built;
}

const sources = (r: P2PCommandRouter) => (r as unknown as { liveSources: Map<string, unknown> }).liveSources;

describe("a second camera on a station already serving one", () => {
  it("is refused, naming the channel that holds the station", async () => {
    const r = router();
    const held = await r.sharedLiveSourceFor(SIBLING);
    held.attach();

    await expect(r.sharedLiveSourceFor(DOORBELL)).rejects.toMatchObject({
      name: "StationBusyError",
      servingChannel: 0,
      retryable: true,
    });
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
    expect(sources(r).has(`${STATION_SN}:2`)).toBe(false);
  });

  it("is admitted once the first releases the station", async () => {
    const r = router();
    const held = await r.sharedLiveSourceFor(SIBLING);
    const consumer = held.attach();
    await expect(r.sharedLiveSourceFor(DOORBELL)).rejects.toBeInstanceOf(StationBusyError);

    consumer.detach();

    expect(await r.sharedLiveSourceFor(DOORBELL)).toBeDefined();
  });

  /**
   * The case a motion notification produces: something records a camera, the operator taps that camera's tile,
   * and both want the SAME channel. One pull serves them, so there is no second camera and nothing to refuse.
   */
  it("does not apply to the same camera, which shares one pull however many hold it", async () => {
    const r = router();
    const opened = await r.sharedLiveSourceFor(DOORBELL);
    opened.attach();

    const joined = await r.sharedLiveSourceFor(DOORBELL);

    expect(joined).toBe(opened);
    joined.attach();
    expect(joined.consumerCount).toBe(2);
    expect(sources(r).size).toBe(1);
  });

  /**
   * A pull nothing is attached to is not the station being served, it is a linger nobody asked to keep. It is
   * released rather than counted, because the alternative is refusing a camera for the sake of one nobody is
   * using.
   */
  it("releases a sibling pull nothing is attached to, rather than refusing for it", async () => {
    const r = router();
    const lingering = await r.sharedLiveSourceFor(SIBLING);
    expect(lingering.consumerCount).toBe(0);

    expect(await r.sharedLiveSourceFor(DOORBELL)).toBeDefined();
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(false);
  });

  /**
   * A failed start fails its consumers without detaching them, so a caller holding a dead handle leaves the
   * count non-zero. Counting that as the station being served would refuse every later stream until the client
   * restarted, which is the failure this prevents rather than the one it causes.
   */
  it("does not let a stopped sibling hold the station, even with consumers still attached", async () => {
    const r = router();
    const dead = await r.sharedLiveSourceFor(SIBLING);
    dead.attach();
    dead.dispose();
    expect(dead.state).toBe("stopped");

    expect(await r.sharedLiveSourceFor(DOORBELL)).toBeDefined();
  });
});

/**
 * Arbitration belongs to a station, and a standalone camera is its own. Nothing scopes this to attached
 * cameras by accident: the map is keyed by station and channel, so a standalone camera has no sibling to
 * contend with, and the refusal is gated on the attachment fact as well.
 */
describe("a standalone camera", () => {
  it("is never refused for another standalone camera, having no station to share", async () => {
    const r = router();
    const other = await r.sharedLiveSourceFor(SOLO_B);
    other.attach();

    expect(await r.sharedLiveSourceFor(SOLO_A)).toBeDefined();
    expect(sources(r).has(`${SOLO_B}:0`)).toBe(true);
  });
});
