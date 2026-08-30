import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { LiveStream } from "../live-stream.js";
import type { P2PFrame, P2PSession } from "../p2p-session.js";

/**
 * A camera attached to a station receives its own media and nothing else, unconditionally.
 *
 * A station fans several cameras out over one session and tags every media frame with the camera it belongs
 * to, so each stream matches its own channel. That match used to have an escape hatch: after enough frames
 * tagged for another camera with none of its own, a stream concluded the station was tagging wrongly and took
 * every frame from then on.
 *
 * The hatch cannot be made safe here. A station serving one camera at a time keeps serving the previous one
 * while a new start is in flight, so a camera opened after another is routinely handed nothing but its
 * sibling's frames to begin with — and a stream that gave up then adopted that sibling's video and audio for
 * the rest of its life. Every attempt to qualify the condition left a hole: keying it on whether a sibling had
 * a start outstanding failed the moment the sibling's pull was released, because the frames already in flight
 * then belonged to a channel nothing had started.
 *
 * What the hatch protected against was a station that tags an attached camera's frames with a channel other
 * than the one started, which would leave the stream delivering nothing. That is DETECTABLE — the warm-up
 * deadline raises a typed start failure naming it — while serving another camera's picture is silent, and for
 * a security camera it is the worse of the two by a wide margin.
 */
class FakeSession extends EventEmitter {
  decodeVideoFrame(data: Buffer, _signCode: number): Buffer | undefined {
    const declared = data.readUInt32LE(0);
    return data.subarray(22, 22 + declared);
  }

  startLiveMedia(): void {}
  stopLiveMedia(): void {}

  push(frame: Partial<P2PFrame>): void {
    this.emit("data", frame as P2PFrame);
  }
}

const SC4 = Buffer.from([0, 0, 0, 1]);

function videoFrame(channel: number, nal = Buffer.from([0x65, 0x11])): Partial<P2PFrame> {
  const header = Buffer.alloc(0x16);
  header.writeUInt8(0x01, 0x04);
  header.writeInt16LE(1920, 0x0a);
  header.writeInt16LE(1080, 0x0c);
  const body = Buffer.concat([SC4, nal]);
  header.writeUInt32LE(body.length, 0x00);
  return { commandId: 1300, channel, signCode: 0, data: Buffer.concat([header, body]) };
}

function audioFrame(channel: number): Partial<P2PFrame> {
  const header = Buffer.alloc(0x10);
  const payload = Buffer.from([0xff, 0xf1, 0x4c, 0x80]);
  header.writeUInt32LE(payload.length, 0x00);
  header.writeUInt8(0, 0x05);
  return { commandId: 1301, channel, signCode: 0, data: Buffer.concat([header, payload]) };
}

function attachedStream(channel: number) {
  const session = new FakeSession();
  const stream = new LiveStream(session as unknown as P2PSession, {
    channel,
    homeBaseAttached: true,
    keepAliveMs: 0,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const video: number[] = [];
  const audio: number[] = [];
  stream.on("video", () => video.push(1));
  stream.on("audio", () => audio.push(1));
  stream.start();
  return { session, stream, video, audio };
}

/** Far more than any tolerance a give-up rule could have used. */
const RELENTLESS = 400;

describe("an attached camera's channel filter", () => {
  it("never delivers another channel's video, however long the station serves it", () => {
    const { session, video } = attachedStream(2);
    for (let i = 0; i < RELENTLESS; i++) session.push(videoFrame(3));
    expect(video).toHaveLength(0);
  });

  it("never delivers another channel's audio", () => {
    const { session, audio } = attachedStream(2);
    for (let i = 0; i < RELENTLESS; i++) session.push(audioFrame(3));
    expect(audio).toHaveLength(0);
  });

  it("delivers its own media the moment the station switches to it", () => {
    const { session, video } = attachedStream(2);
    for (let i = 0; i < RELENTLESS; i++) session.push(videoFrame(3));
    session.push(videoFrame(2));
    expect(video).toHaveLength(1);
  });

  it("keeps filtering after its own media has flowed", () => {
    const { session, video } = attachedStream(2);
    session.push(videoFrame(2));
    for (let i = 0; i < RELENTLESS; i++) session.push(videoFrame(3));
    expect(video).toHaveLength(1);
  });

  it("delivers only its own out of media interleaved from several cameras", () => {
    const { session, video } = attachedStream(2);
    for (const channel of [0, 1, 2, 3, 0, 2, 3, 1, 2]) session.push(videoFrame(channel));
    expect(video).toHaveLength(3);
  });

  /**
   * A camera that owns its session numbers its stream for itself: one was started on channel 0 and tagged its
   * frames channel 1, so matching there would drop the whole stream. Only an attached camera filters.
   */
  it("does not filter a camera that owns its session", () => {
    const session = new FakeSession();
    const stream = new LiveStream(session as unknown as P2PSession, {
      channel: 0,
      homeBaseAttached: false,
      keepAliveMs: 0,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const video: number[] = [];
    stream.on("video", () => video.push(1));
    stream.start();
    session.push(videoFrame(1));
    expect(video).toHaveLength(1);
  });
});
