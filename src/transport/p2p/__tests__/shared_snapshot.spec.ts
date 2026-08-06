import { EventEmitter } from "node:events";
import { captureSnapshotFromShared } from "../media.js";
import { SharedLiveSource } from "../shared-live-source.js";
import type { LiveStreamHandle, LiveVideoFrame } from "../../../core/contracts.js";

class FakeStream extends EventEmitter implements LiveStreamHandle {
  started = 0;
  stopped = 0;
  start(): this {
    this.started++;
    return this;
  }
  stop(): void {
    this.stopped++;
  }
  video(f: LiveVideoFrame) {
    this.emit("video", f);
  }
}

function frame(): LiveVideoFrame {
  // a bogus keyframe — enough to prime; the ffmpeg decode is expected to fail (unit env)
  return { keyframe: true, width: 8, height: 8, codec: "h264", data: Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 3]) };
}

describe("captureSnapshotFromShared (V6 snapshot as consumer)", () => {
  it("rides a warm, primed source with NO second pull and cleans up its consumer", async () => {
    const streams: FakeStream[] = [];
    const source = new SharedLiveSource({
      makeStream: () => {
        const s = new FakeStream();
        streams.push(s);
        return s;
      },
    });
    const watcher = source.attach(); // an existing viewer warms the single pull
    streams[0].video(frame()); // cache a keyframe (V2 prime)
    expect(streams[0].started).toBe(1);

    // Snapshot attaches as a consumer; the primed IDR decodes (ffmpeg fails in unit env → rejects),
    // but the point under test is transport behaviour: no extra pull, consumer released after.
    await expect(captureSnapshotFromShared(source, { timeoutMs: 1000 })).rejects.toBeInstanceOf(Error);

    expect(streams).toHaveLength(1); // ONE pull total — snapshot rode the warm source
    expect(source.consumerCount).toBe(1); // only the original watcher remains
    watcher.detach();
  });
});
