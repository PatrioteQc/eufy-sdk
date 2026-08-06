import { EventEmitter } from "node:events";
import { LiveStream, DEFAULT_KEEPALIVE_MS } from "../live-stream.js";
import type { P2PSession, P2PFrame } from "../p2p-session.js";

/** Minimal fake P2PSession: records start/stop and lets tests push frames via emit("data"). */
class FakeSession extends EventEmitter {
  started = 0;
  stopped = 0;
  startChannel: number | undefined = undefined;
  startLiveMedia(channel?: number) {
    this.started++;
    this.startChannel = channel;
  }
  stopLiveMedia() {
    this.stopped++;
  }
  push(f: Partial<P2PFrame>) {
    this.emit("data", f as P2PFrame);
  }
}

const SC4 = Buffer.from([0, 0, 0, 1]);

/** Build a plaintext CMD_VIDEO_FRAME: 22-byte header (flag bit0=keyframe, w/h) + Annex-B. */
function videoFrame(opts: {
  keyframe?: boolean;
  width?: number;
  height?: number;
  nal: Buffer;
  channel?: number;
}): Partial<P2PFrame> {
  const hdr = Buffer.alloc(0x16);
  hdr.writeUInt8(opts.keyframe ? 0x01 : 0x00, 0x04);
  hdr.writeInt16LE(opts.width ?? 960, 0x0a);
  hdr.writeInt16LE(opts.height ?? 540, 0x0c);
  const body = Buffer.concat([SC4, opts.nal]);
  return { commandId: 1300, channel: opts.channel ?? 0, signCode: 0, data: Buffer.concat([hdr, body]) };
}

describe("LiveStream", () => {
  function mk(opts = {}) {
    const session = new FakeSession();
    const live = new LiveStream(session as unknown as P2PSession, opts);
    return { session, live };
  }

  it("starts media on start() and stops on stop()", () => {
    const { session, live } = mk();
    live.start();
    expect(session.started).toBe(1);
    live.stop();
    expect(session.stopped).toBe(1);
  });

  it("emits Annex-B video with the 22-byte header stripped + keyframe flag + resolution", () => {
    const { session, live } = mk();
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();
    session.push(videoFrame({ keyframe: true, width: 960, height: 540, nal: Buffer.from([0x67, 1, 2, 3]) }));
    session.push(videoFrame({ keyframe: false, nal: Buffer.from([0x41, 9]) }));
    expect(frames).toHaveLength(2);
    expect(frames[0].keyframe).toBe(true);
    expect(frames[0].width).toBe(960);
    expect(frames[0].height).toBe(540);
    expect(frames[0].data.subarray(0, 4).equals(SC4)).toBe(true); // header gone, starts at NAL start code
    expect(frames[0].data[4]).toBe(0x67); // SPS NAL
    expect(frames[1].keyframe).toBe(false);
  });

  it("sniffs codec on a keyframe and carries it onto following delta frames", () => {
    const { session, live } = mk();
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();
    // keyframe leads with an h265 VPS (0x40 → type 32); the delta after it has no config to sniff
    session.push(videoFrame({ keyframe: true, nal: Buffer.from([0x40, 0x01, 0x0c]) }));
    session.push(videoFrame({ keyframe: false, nal: Buffer.from([0x02, 0x01]) }));
    expect(frames[0].codec).toBe("h265");
    expect(frames[1].codec).toBe("h265"); // delta inherits the last-known codec
  });

  it("defaults codec to h264 before any keyframe", () => {
    const { session, live } = mk();
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();
    session.push(videoFrame({ keyframe: false, nal: Buffer.from([0x21, 0x9a]) }));
    expect(frames[0].codec).toBe("h264");
  });

  it("emits audio with its 16-byte header stripped", () => {
    const { session, live } = mk();
    const audio: Buffer[] = [];
    live.on("audio", (d) => audio.push(d));
    live.start();
    const payload = Buffer.from([10, 11, 12, 13]);
    session.push({
      commandId: 1301,
      channel: 0,
      signCode: 0,
      data: Buffer.concat([Buffer.alloc(0x10), payload]),
    } as any);
    expect(audio).toHaveLength(1);
    expect(audio[0].equals(payload)).toBe(true);
  });

  it("starts the requested camera channel and does NOT filter inbound frames by it", () => {
    const { session, live } = mk({ channel: 3 }); // e.g. T8425
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();
    expect(session.startChannel).toBe(3); // channel is the SEND channel
    // inbound frames are tagged channel 0 by the station regardless — must NOT be dropped
    session.push(videoFrame({ nal: Buffer.from([0x41]), channel: 0 }));
    expect(frames).toHaveLength(1);
  });

  it("does not emit video it cannot decode (encrypted frame, no key)", () => {
    const { session, live } = mk();
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();
    // 22-byte header then random (no start code) = encrypted body, no ecc key → skipped
    session.push({
      commandId: 1300,
      channel: 0,
      signCode: 2,
      data: Buffer.concat([Buffer.alloc(0x16, 7), Buffer.from([9, 9, 9, 9])]),
    } as any);
    expect(frames).toHaveLength(0);
  });
});

/**
 * The keepalive is ON by default. A battery camera stops sending ~8s after the last media start with
 * nothing holding it (measured live: video ceased at 8s and 10s on two battery cameras, with no stop
 * and no error), while a mains camera streamed unprompted for 25s. The nudge is idempotent, so a
 * camera that does not need it is unaffected.
 */
describe("LiveStream keepalive default", () => {
  it("re-issues the media start without the caller asking", () => {
    vi.useFakeTimers();
    try {
      const session = new FakeSession();
      const stream = new LiveStream(session as unknown as P2PSession, { channel: 0 }).start();
      expect(session.started).toBe(1);
      vi.advanceTimersByTime(DEFAULT_KEEPALIVE_MS * 3 + 10);
      expect(session.started).toBeGreaterThanOrEqual(4);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours an explicit 0 as off", () => {
    vi.useFakeTimers();
    try {
      const session = new FakeSession();
      const stream = new LiveStream(session as unknown as P2PSession, { channel: 0, keepAliveMs: 0 }).start();
      vi.advanceTimersByTime(DEFAULT_KEEPALIVE_MS * 5);
      expect(session.started).toBe(1);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
