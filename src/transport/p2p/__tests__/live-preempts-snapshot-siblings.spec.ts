import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";
import { StationBusyError } from "../../../core/contracts.js";

/**
 * A station that serves one camera at a time has to be arbitrated, and a snapshot tile is not a viewer.
 *
 * Opening a live view in the Home app takes the cell fullscreen: the other cells are not on screen, so the
 * pulls refreshing them have no one to serve. Left running they re-issue their own media start every retry
 * tick and keep re-tasking the station away from the camera the user is actually looking at — measured as
 * four pulls warming together off one HomeBase, a live request landing 1.4 s later, and the live consumer
 * receiving nothing but the retained keyframe until its deadline fired.
 *
 * Preemption is by purpose, not by whether a pull is idle: a lingering pull already yields, and a pull with a
 * live consumer is a second person watching and must never be dropped. Only a pull whose consumers are all
 * snapshots gives way, and only to a live request.
 *
 * The same camera is not a sibling and is never dropped — a snapshot that already opened the session is the
 * cheapest possible start for the live view that follows, which is the whole point of sharing one source.
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

describe("a live request on a station whose other cameras are refreshing tiles", () => {
  it("drops a sibling pull that only a snapshot is holding, so the station is left on the live camera", async () => {
    const r = router();
    const tile = await r.sharedLiveSourceFor(SIBLING, {}, "snapshot");
    tile.attach("snapshot");
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);

    await r.sharedLiveSourceFor(DOORBELL, {}, "live");

    expect(sources(r).has(`${STATION_SN}:0`)).toBe(false);
  });

  /**
   * A station serving one camera at a time cannot serve a second viewer, and admitting one does not make it
   * try harder: measured on a base carrying three attached cameras, each opened stream took the station from
   * the others in turn and all three received their media in bursts. So the second viewer is refused, and the
   * one already being served keeps its pull. Which camera deserves the station is the caller's call, so
   * nothing is queued and nothing is pre-empted.
   */
  it("refuses a second viewer, naming the channel the station is already serving", async () => {
    const r = router();
    const watched = await r.sharedLiveSourceFor(SIBLING, {}, "live");
    watched.attach("live");

    await expect(r.sharedLiveSourceFor(DOORBELL, {}, "live")).rejects.toMatchObject({
      name: "StationBusyError",
      servingChannel: 0,
      retryable: true,
    });
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
    expect(sources(r).has(`${STATION_SN}:2`)).toBe(false);
  });

  it("admits the second viewer once the first releases the station", async () => {
    const r = router();
    const watched = await r.sharedLiveSourceFor(SIBLING, {}, "live");
    const consumer = watched.attach("live");
    await expect(r.sharedLiveSourceFor(DOORBELL, {}, "live")).rejects.toBeInstanceOf(StationBusyError);

    consumer.detach();

    expect(await r.sharedLiveSourceFor(DOORBELL, {}, "live")).toBeDefined();
  });

  /** A still yields the station rather than competing for it, so it is never refused for a viewer. */
  it("still takes a snapshot while a sibling is being watched", async () => {
    const r = router();
    const watched = await r.sharedLiveSourceFor(SIBLING, {}, "live");
    watched.attach("live");

    expect(await r.sharedLiveSourceFor(DOORBELL, {}, "snapshot")).toBeDefined();
  });

  /** Joining the pull already open on THIS camera is not a second viewer, however many consumers it has. */
  it("lets a second viewer join the same camera, which costs the station nothing", async () => {
    const r = router();
    const opened = await r.sharedLiveSourceFor(DOORBELL, {}, "live");
    opened.attach("live");

    expect(await r.sharedLiveSourceFor(DOORBELL, {}, "live")).toBe(opened);
  });

  /**
   * The case a motion notification produces: something records a camera, the operator taps that camera's tile,
   * and both want the SAME channel. One pull serves them, so there is no second viewer and nothing to refuse.
   * This is the common shape by far, which is why the refusal above costs less than it appears to.
   */
  it("serves a recording and a viewer of the same camera from one pull", async () => {
    const r = router();
    const recording = await r.sharedLiveSourceFor(DOORBELL, {}, "live");
    recording.attach("live");

    const viewer = await r.sharedLiveSourceFor(DOORBELL, {}, "live");

    expect(viewer).toBe(recording);
    expect(viewer.consumerCount).toBe(1);
    expect(viewer.attach("live")).toBeDefined();
    expect(viewer.consumerCount).toBe(2);
    expect(sources(r).size).toBe(1);
  });

  /**
   * A failed start fails its consumers without detaching them, so a caller still holding a dead handle leaves
   * the count non-zero. Counting that as a viewer would refuse every later stream on the station until the
   * client restarted, which is the failure this arbitration exists to prevent rather than cause.
   */
  it("does not let a stopped sibling hold the station, even with consumers still attached to it", async () => {
    const r = router();
    const dead = await r.sharedLiveSourceFor(SIBLING, {}, "live");
    dead.attach("live");
    dead.dispose();
    expect(dead.state).toBe("stopped");

    expect(await r.sharedLiveSourceFor(DOORBELL, {}, "live")).toBeDefined();
  });

  it("keeps a sibling tile when the request is itself a tile, so a home page does not fight itself", async () => {
    const r = router();
    const tile = await r.sharedLiveSourceFor(SIBLING, {}, "snapshot");
    tile.attach("snapshot");

    await r.sharedLiveSourceFor(DOORBELL, {}, "snapshot");

    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
  });

  /**
   * The measured failure: the live view reused the doorbell's own snapshot pull, which is the cheap start it
   * should be, while the OTHER cells' pulls kept re-tasking the station. Reuse is the path that must free the
   * station, not just the path that builds a new source.
   */
  it("frees the station's other channels even when it reuses the pull already open on this one", async () => {
    const r = router();
    const tile = await r.sharedLiveSourceFor(SIBLING, {}, "snapshot");
    tile.attach("snapshot");
    const own = await r.sharedLiveSourceFor(DOORBELL, {}, "snapshot");
    own.attach("snapshot");

    expect(await r.sharedLiveSourceFor(DOORBELL, {}, "live")).toBe(own);
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(false);
  });

  it("reuses the very source a snapshot opened for the same camera, rather than dropping it", async () => {
    const r = router();
    const opened = await r.sharedLiveSourceFor(DOORBELL, {}, "snapshot");
    opened.attach("snapshot");

    expect(await r.sharedLiveSourceFor(DOORBELL, {}, "live")).toBe(opened);
  });
});

/**
 * Arbitration is a station's business, and a standalone camera is its own station.
 *
 * Nothing scopes this to attached cameras explicitly, and nothing should: the map is keyed by station and
 * channel, so a standalone camera has no sibling to take a channel from and none to lose one to. Stated as a
 * test because it is a property of the key, which a later change could widen without noticing.
 */
describe("a live request on a standalone camera", () => {
  it("leaves another standalone camera's snapshot pull alone, having no channel to contend for", async () => {
    const r = router();
    const other = await r.sharedLiveSourceFor(SOLO_B, {}, "snapshot");
    other.attach("snapshot");

    await r.sharedLiveSourceFor(SOLO_A, {}, "live");

    expect(sources(r).has(`${SOLO_B}:0`)).toBe(true);
  });
});
