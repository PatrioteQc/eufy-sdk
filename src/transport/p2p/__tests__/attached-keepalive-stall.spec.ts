import { describe, expect, it, vi } from "vitest";
import { LiveStream } from "../live-stream.js";
import type { P2PSession } from "../p2p-session.js";
import { FakeP2PSession, p2pVideoFrame } from "./live-source-fixtures.js";

/**
 * An attached stream the station stopped serving re-asserts its channel, once its media has actually stopped.
 *
 * The 3 s re-assert is settled by the first own-channel frame, because a station serving one camera at a time
 * is re-tasked by every re-assert: two attached streams doing it continuously contend forever — measured as a
 * full start every 3 s from each, and settling it is what let both hold a 40 s stream.
 *
 * Settling it for the stream's whole life left nothing to recover a stream the station later gave to a
 * sibling: frames stop, no error is raised, no `stop` is emitted, and the consumer starves for as long as it
 * waits. The warm-up watch that would have caught it was cleared by the first frame.
 *
 * So the settle holds only while media keeps arriving. Silence for the stall window re-arms the re-assert, and
 * the next own-channel frame settles it again — the contention is avoided exactly while it would be harmful.
 */
/** A keyframe tagged for `channel`, as the station sends it. */
const ownFrame = (channel: number) =>
  p2pVideoFrame({ nal: Buffer.from([0x65, 0x11]), keyframe: true, width: 1920, height: 1080, channel });

function attached(stallMs: number) {
  const session = new FakeP2PSession();
  const stream = new LiveStream(session as unknown as P2PSession, {
    channel: 2,
    homeBaseAttached: true,
    keepAliveMs: 20,
    stallMs,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  stream.on("video", () => undefined);
  stream.start();
  return { session, stream };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("an attached stream whose station stopped serving it", () => {
  it("stops re-asserting while its own media arrives", async () => {
    const { session, stream } = attached(200);
    session.push(ownFrame(2));
    const settled = session.starts.length;
    await settle(70);

    expect(session.starts.length).toBe(settled);
    stream.stop();
  });

  it("re-asserts again after its media has been silent for the stall window", async () => {
    const { session, stream } = attached(50);
    session.push(ownFrame(2));
    const settled = session.starts.length;
    await settle(140);

    expect(session.starts.length).toBeGreaterThan(settled);
    stream.stop();
  });

  it("settles again on the next frame, so recovery does not become the contention it replaced", async () => {
    const { session, stream } = attached(50);
    session.push(ownFrame(2));
    await settle(140);
    session.push(ownFrame(2));
    const resettled = session.starts.length;
    await settle(40);

    expect(session.starts.length).toBe(resettled);
    stream.stop();
  });

  it("re-asserts nothing once stopped", async () => {
    const { session, stream } = attached(40);
    session.push(ownFrame(2));
    stream.stop();
    const atStop = session.starts.length;
    await settle(120);

    expect(session.starts.length).toBe(atStop);
  });
});
