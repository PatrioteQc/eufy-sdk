import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { LiveStream } from "../live-stream.js";
import type { P2PSession } from "../p2p-session.js";
import { SharedLiveSource } from "../shared-live-source.js";
import { H264, streamFactory, unit, videoFrame } from "./live-source-fixtures.js";

/**
 * A re-issue on a stream that has delivered NOTHING is a start, not a keepalive.
 *
 * On an own-session camera the two differ: a keepalive (1139) holds a stream the station is already serving,
 * and by this session's own account "holds a stream that was never started and cannot begin one". The station
 * is only told to stream by a real start, and the session sends one only while it does not believe the channel
 * is already started.
 *
 * That belief outlives the evidence for it. Measured on a standalone battery camera: a start acknowledged with
 * no media, the source left lingering with its stream open, and the next attempt inside that linger window
 * re-issuing four keepalives and no start at all — nothing arrived, and only a session rebuilt after the
 * deadline recovered it. Three attempts, then a fourth that worked, with the same request.
 *
 * The source holds the evidence: nothing delivered means the station is not serving this channel, whatever the
 * session believes. So a re-issue forces a start until media arrives, and keeps the keepalive afterwards —
 * which is what the keepalive is for, and why an attached camera, whose start has no keepalive form at all,
 * is unaffected either way.
 */
class FakeSession extends EventEmitter {
  readonly sent: string[] = [];
  private started = false;

  startLiveMedia(_channel: number, _accountId?: string, _attached?: boolean, opts?: { force?: boolean }): void {
    if (opts?.force) this.started = false;
    this.sent.push(this.started ? "keepalive" : "start");
    this.started = true;
  }

  stopLiveMedia(): void {
    this.started = false;
  }
}

const keyframe = () => videoFrame(unit(H264.sps, H264.pps, H264.idr), { keyframe: true });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a re-issue on an own-session stream", () => {
  it("is a start where nothing has been delivered, the station not having been told to stream", () => {
    const session = new FakeSession();
    const stream = new LiveStream(session as unknown as P2PSession, {
      channel: 0,
      keepAliveMs: 0,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }).start();

    stream.nudge(true);
    stream.nudge(true);

    expect(session.sent).toEqual(["start", "start", "start"]);
    stream.stop();
  });

  it("is a keepalive once media has arrived, which is what a keepalive holds", () => {
    const session = new FakeSession();
    const stream = new LiveStream(session as unknown as P2PSession, {
      channel: 0,
      keepAliveMs: 0,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }).start();

    stream.nudge();
    stream.nudge();

    expect(session.sent).toEqual(["start", "keepalive", "keepalive"]);
    stream.stop();
  });
});

describe("a warming source with nothing delivered", () => {
  it("forces its re-issue, so a reused stream the station never served is started rather than held", async () => {
    const { makeStream, streams } = streamFactory();
    const src = new SharedLiveSource({
      makeStream,
      warmRetryMs: 20,
      warmTimeoutMs: 5_000,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    src.attach().on("error", () => undefined);
    await settle(70);

    expect(streams[0]!.forced).toBeGreaterThan(0);
  });

  it("stops forcing once media has arrived", async () => {
    const { makeStream, streams } = streamFactory();
    const src = new SharedLiveSource({
      makeStream,
      warmRetryMs: 20,
      warmTimeoutMs: 5_000,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const consumer = src.attach();
    consumer.on("error", () => undefined);
    consumer.on("video", () => undefined);
    streams[0]!.video(keyframe());
    const forcedAtDelivery = streams[0]!.forced;
    await settle(70);

    expect(streams[0]!.forced).toBe(forcedAtDelivery);
  });
});
