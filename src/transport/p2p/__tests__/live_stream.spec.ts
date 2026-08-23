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
  /**
   * Mirrors the real session's extraction: the body is the `payloadLength` the header declares, and an
   * encrypted frame needs the RSA key this fake has no equivalent of, so it answers undefined there.
   */
  decodeVideoFrame(data: Buffer, signCode: number): Buffer | undefined {
    if (data.length < 22) return undefined;
    const declared = data.readUInt32LE(0);
    if (signCode > 0 && declared >= 128) return undefined;
    return data.subarray(22, 22 + declared);
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
  hdr.writeUInt32LE(body.length, 0x00); // every real frame declares the payload it carries
  return { commandId: 1300, channel: opts.channel ?? 0, signCode: 0, data: Buffer.concat([hdr, body]) };
}

/** Build a CMD_AUDIO_FRAME: 16-byte header carrying the codec id at 0x05, then the payload. */
function audioFrame(audioType: number, payload: Buffer): Partial<P2PFrame> {
  const hdr = Buffer.alloc(0x10);
  hdr.writeUInt32LE(payload.length, 0x00);
  hdr.writeUInt8(audioType, 0x05);
  return { commandId: 1301, channel: 0, signCode: 0, data: Buffer.concat([hdr, payload]) };
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

  it("emits audio with its 16-byte header stripped, carrying the declared codec", () => {
    const { session, live } = mk();
    const audio: any[] = [];
    live.on("audio", (f) => audio.push(f));
    live.start();
    const payload = Buffer.from([10, 11, 12, 13]);
    session.push(audioFrame(0, payload) as any);
    expect(audio).toHaveLength(1);
    expect(audio[0].codec).toBe("aac-lc");
    expect(audio[0].data.equals(payload)).toBe(true);
  });

  it("maps each codec id the app accepts, and re-reads it on every frame", () => {
    const { session, live } = mk();
    const audio: any[] = [];
    live.on("audio", (f) => audio.push(f));
    live.start();
    const p = Buffer.from([1]);
    session.push(audioFrame(0, p) as any);
    session.push(audioFrame(7, p) as any);
    session.push(audioFrame(2, p) as any);
    expect(audio.map((f) => f.codec)).toEqual(["aac-lc", "aac-eld", "g711a"]);
  });

  it("drops every frame whose codec id the station did not declare", () => {
    const { session, live } = mk();
    const audio: any[] = [];
    live.on("audio", (f) => audio.push(f));
    live.start();
    const p = Buffer.from([1]);
    session.push(audioFrame(9, p) as any);
    expect(audio).toHaveLength(0);
    session.push(audioFrame(7, p) as any);
    session.push(audioFrame(9, p) as any);
    expect(audio.map((f) => f.codec)).toEqual(["aac-eld"]);
  });

  it("starts the requested camera channel", () => {
    const { session, live } = mk({ channel: 3 }); // e.g. T8425
    live.start();
    expect(session.startChannel).toBe(3);
  });

  /**
   * A camera that owns its session numbers its stream for itself: one was measured started on channel 0
   * and tagging its frames channel 1. There is only one camera on that session, so there is nothing to tell
   * apart — and matching the started channel there would drop the entire stream.
   */
  it("takes every frame on an own-session camera, whatever channel the station tags", () => {
    const { session, live } = mk({ channel: 0 });
    const frames: any[] = [];
    live.on("video", (f) => frames.push(f));
    live.start();

    session.push(videoFrame({ nal: Buffer.from([0x41]), channel: 1 }));

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
 * A station splits an access unit larger than its chunk size across several `CMD_VIDEO_FRAME` frames.
 * `LiveVideoFrame` is documented as one access unit, and a consumer that reads `keyframe` as "this buffer
 * is independently decodable", switches codec at a keyframe, or counts frames is deciding per access unit;
 * delivering chunks silently makes all three wrong.
 *
 * The wire semantics below are measured on two camera models, not inferred:
 *  - each frame declares only the payload IT carries, so the unit's total is nowhere on the wire — a
 *    70190-byte unit arrived as 64000 then 6190;
 *  - the frames of one unit repeat its header (same timestamp, same sequence field);
 *  - every frame of a split unit is filled to 64000 except the last;
 *  - a frame that starts a unit begins with a start code; a continuation begins mid-NAL.
 */
describe("LiveStream access-unit reassembly", () => {
  const CHUNK = 64000;

  /** The 22-byte plaintext header, as the station repeats it on every frame of one unit. */
  function header(payloadLength: number, opts: { keyframe?: boolean; sequence?: number; timestamp?: number } = {}) {
    const hdr = Buffer.alloc(0x16);
    hdr.writeUInt32LE(payloadLength, 0x00);
    hdr.writeUInt8(opts.keyframe === false ? 0x00 : 0x01, 0x04);
    hdr.writeUInt16LE(opts.sequence ?? 0, 0x06);
    hdr.writeInt16LE(1920, 0x0a);
    hdr.writeInt16LE(1080, 0x0c);
    hdr.writeUInt32LE(opts.timestamp ?? 0x1000, 0x0e);
    return hdr;
  }

  /** One `CMD_VIDEO_FRAME`: its header declares the body it carries, exactly as the station does. */
  function videoChunk(body: Buffer, opts: { keyframe?: boolean; sequence?: number; timestamp?: number } = {}) {
    return {
      commandId: 1300,
      channel: 0,
      signCode: 0,
      data: Buffer.concat([header(body.length, opts), body]),
    };
  }

  /** A frame filled to exactly the split threshold: parameter sets, then the start of an IDR. */
  const idrHead = Buffer.concat([SC4, Buffer.from([0x67, 0x42, 0x00]), SC4, Buffer.from([0x65, 0x88])]);
  const filled = Buffer.concat([idrHead, Buffer.alloc(CHUNK - idrHead.length, 0x11)]);
  /** The rest of that IDR — mid-NAL, so no start code of its own, and short so it ends the unit. */
  const tail = Buffer.from([0x22, 0x33, 0x44, 0x55, 0x66]);
  /** An ordinary small unit, complete in one frame. */
  const small = Buffer.concat([SC4, Buffer.from([0x41, 0x9a, 0x02])]);

  function mk(opts = {}) {
    const session = new FakeSession();
    const frames: any[] = [];
    const live = new LiveStream(session as unknown as P2PSession, opts).start();
    live.on("video", (f) => frames.push(f));
    return { session, live, frames };
  }

  it("delivers a split unit as ONE whole access unit", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled));
    session.push(videoChunk(tail));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(Buffer.concat([filled, tail]))).toBe(true);
    expect(frames[0]).toMatchObject({ keyframe: true, width: 1920, height: 1080 });
  });

  it("emits nothing while the unit's latest frame is still full", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled));

    expect(frames).toEqual([]);
  });

  /**
   * The continuation repeats the keyframe flag while carrying no parameter sets, so a consumer beginning a
   * decode there has nothing to decode against.
   */
  it("never announces a continuation as a keyframe of its own", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled));
    session.push(videoChunk(tail));

    expect(frames.filter((f) => f.keyframe)).toHaveLength(1);
  });

  /** The overwhelming majority of units arrive in one frame below the threshold: no holding, no latency. */
  it("delivers a unit that arrives in one frame immediately", () => {
    const { session, frames } = mk();

    session.push(videoChunk(small, { keyframe: false }));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(small)).toBe(true);
  });

  /**
   * The threshold is what a splitting station FILLS to, not a size above which a unit must be split.
   * Stations that never split deliver whole units far bigger than it — measured at 148057 and 231954
   * bytes — and holding those back, then discarding them as truncated, costs the very keyframes a
   * decoder cannot start without.
   */
  it("delivers a single-frame unit larger than the threshold immediately", () => {
    const { session, frames } = mk();
    const big = Buffer.concat([
      SC4,
      Buffer.from([0x67, 0x42, 0x00]),
      SC4,
      Buffer.from([0x65, 0x88]),
      Buffer.alloc(90_000, 0x11),
    ]);

    session.push(videoChunk(big));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(big)).toBe(true);
  });

  /**
   * Identity and the missing start code are required together. A following unit that opens with a start
   * code can never be absorbed, however the station labelled it — a merge is invisible to a consumer that
   * trusts the contract.
   */
  it("does not absorb a following unit that opens with a start code", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled, { timestamp: 0x1000 }));
    session.push(videoChunk(small, { timestamp: 0x1000, keyframe: false }));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(small)).toBe(true);
  });

  /** Nor one whose header describes a different unit, even where it continues mid-NAL. */
  it("does not absorb a continuation-shaped frame belonging to another unit", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled, { timestamp: 0x1000 }));
    session.push(videoChunk(tail, { timestamp: 0x2000 }));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(tail)).toBe(true);
  });

  /**
   * A lost datagram costs the whole frame the P2P layer was reassembling, so a unit whose tail never
   * arrives is ended by the next unit while still full. Handing those bytes to a decoder is what produces
   * `error while decoding MB …, bytestream -28` — it ran off the end of a slice whose header promised more.
   */
  it("drops a unit whose tail never arrived rather than delivering truncated bytes", () => {
    const { session, frames } = mk();

    session.push(videoChunk(filled, { timestamp: 0x1000 }));
    session.push(videoChunk(small, { timestamp: 0x2000, keyframe: false }));

    expect(frames).toHaveLength(1);
    expect(frames[0].data.equals(small)).toBe(true);
  });

  /** The loss was previously silent in both directions: no frame, and nothing said so. */
  it("reports a dropped unit instead of losing it silently", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { session } = mk({ logger });

    session.push(videoChunk(filled, { timestamp: 0x1000 }));
    session.push(videoChunk(small, { timestamp: 0x2000, keyframe: false }));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain(`${filled.length}`);
  });

  /** One line per stream, not per frame: a camera dropping units steadily must not flood a host's log. */
  it("warns once per stream and keeps the rest at debug level", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { session } = mk({ logger });

    for (let i = 1; i <= 3; i++) {
      session.push(videoChunk(filled, { timestamp: i * 0x1000 }));
      session.push(videoChunk(small, { timestamp: i * 0x1000 + 1, keyframe: false }));
    }

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(2);
  });
});

/**
 * A HomeBase fans several cameras out over ONE session, so every stream on it reads the same inbound feed.
 * The station says which camera a media frame belongs to — measured with two cameras of different geometry
 * warm at once, the frame's channel field partitioned them exactly (1920x1080 on the started channel 0,
 * 640x480 on channel 2, video and audio alike) while each handle was delivered both cameras' frames.
 */
describe("LiveStream channel isolation on a HomeBase", () => {
  function attached(channel: number, logger?: unknown) {
    const session = new FakeSession();
    const frames: any[] = [];
    const audio: any[] = [];
    const live = new LiveStream(session as unknown as P2PSession, {
      channel,
      homeBaseAttached: true,
      logger: logger as never,
    }).start();
    live.on("video", (f) => frames.push(f));
    live.on("audio", (f) => audio.push(f));
    return { session, frames, audio };
  }

  it("takes the frames the station tagged for its own camera", () => {
    const { session, frames } = attached(2);

    session.push(videoFrame({ nal: Buffer.from([0x41]), channel: 2 }));

    expect(frames).toHaveLength(1);
  });

  it("drops another camera's video, which used to interleave into this stream", () => {
    const { session, frames } = attached(2);

    session.push(videoFrame({ nal: Buffer.from([0x41]), channel: 2 }));
    session.push(videoFrame({ nal: Buffer.from([0x41]), channel: 0 }));

    expect(frames).toHaveLength(1);
  });

  /** Audio is tagged the same way — a doorbell's audio in another camera's stream is the same defect. */
  it("drops another camera's audio too", () => {
    const { session, audio } = attached(2);

    session.push({ ...audioFrame(0, Buffer.from([1, 2])), channel: 2 } as any);
    session.push({ ...audioFrame(0, Buffer.from([1, 2])), channel: 0 } as any);

    expect(audio).toHaveLength(1);
  });

  /**
   * A station that tags an attached camera's frames with something other than the started channel would
   * otherwise get a stream that never delivers anything. After a bounded run of frames with none of its own
   * it stops filtering and says so — one account's firmware is not every account's.
   */
  it("stops filtering, with a warning, if none of its own frames ever arrive", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { session, frames } = attached(2, logger);

    for (let i = 0; i < 40; i++) session.push(videoFrame({ nal: Buffer.from([0x41]), channel: 0 }));

    expect(frames.length).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain("station tags media channel 0");
  });

  /** Once its own tag has been seen, the fallback must never fire: the station has proven it discriminates. */
  it("keeps filtering once its own camera's tag has been seen", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { session, frames } = attached(2, logger);

    session.push(videoFrame({ nal: Buffer.from([0x41]), channel: 2 }));
    for (let i = 0; i < 40; i++) session.push(videoFrame({ nal: Buffer.from([0x41]), channel: 0 }));

    expect(frames).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
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
