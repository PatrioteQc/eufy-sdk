import { describe, expect, it, vi } from "vitest";
import { SharedLiveSource } from "../shared-live-source.js";
import { H264, streamFactory, unit, videoFrame } from "./live-source-fixtures.js";

/**
 * A source reused inside its linger window is watched like any other.
 *
 * The linger keeps a stream alive after its last consumer leaves, so re-opening the same camera costs nothing.
 * It also keeps the last keyframe, which a joining consumer is primed with so it decodes without waiting a
 * whole group of pictures.
 *
 * Together those two made a silent failure: a consumer joining a lingering source is handed a cached keyframe
 * at once, so a caller sees media and commits to it — an adaptation process, a negotiated HomeKit session —
 * while the stream underneath may already have stopped being served. Warming was the only thing that armed a
 * deadline, and reuse skips warming by definition, so nothing ever timed out. Observed on a real account as a
 * 30 s HomeKit timeout whose whole trace was one primed keyframe and then silence, where the retry that
 * followed rebuilt the stream and reached its first output in 0.69 s.
 *
 * A primed keyframe is evidence about the past. Only a frame that arrives after the join says the stream is
 * still being served.
 */
const keyframe = () => videoFrame(unit(H264.sps, H264.pps, H264.idr), { keyframe: true });

function source(over: { lingerMs?: number; warmTimeoutMs?: number } = {}) {
  const { makeStream, streams } = streamFactory();
  const src = new SharedLiveSource({
    makeStream,
    warmRetryMs: 10_000,
    warmTimeoutMs: 50,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  });
  return { src, streams };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a consumer joining a lingering source", () => {
  it("fails when no frame arrives after the join, however recent the primed one", async () => {
    const { src, streams } = source();
    const first = src.attach();
    streams[0]!.video(keyframe());
    first.detach();

    const rejoined = src.attach();
    const failures: Error[] = [];
    rejoined.on("error", (error) => failures.push(error));
    rejoined.on("video", () => undefined);
    await settle(150);

    expect(failures.map((error) => error.name)).toEqual(["LiveStreamStartError"]);
  });

  it("does not fail when the stream is still being served", async () => {
    const { src, streams } = source();
    const first = src.attach();
    streams[0]!.video(keyframe());
    first.detach();

    const rejoined = src.attach();
    const failures: Error[] = [];
    rejoined.on("error", (error) => failures.push(error));
    rejoined.on("video", () => undefined);
    streams[0]!.video(keyframe());
    await settle(150);

    expect(failures).toEqual([]);
    rejoined.detach();
  });

  /** The first consumer of a cold source is already watched by warming; reuse must not double the watch. */
  it("leaves a cold first attach to the warm-up it already had", async () => {
    const { src, streams } = source();
    const consumer = src.attach();
    const failures: Error[] = [];
    consumer.on("error", (error) => failures.push(error));
    streams[0]!.video(keyframe());
    await settle(150);

    expect(failures).toEqual([]);
    consumer.detach();
  });
});
