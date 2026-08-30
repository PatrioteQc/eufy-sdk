import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { LiveStream } from "../live-stream.js";
import type { P2PFrame, P2PSession } from "../p2p-session.js";

/**
 * Two cameras on one station must never receive each other's media.
 *
 * A station fans several cameras out over one session and tags every media frame with the camera it belongs
 * to, so each stream filters for its own. That filter has an escape hatch for a station which tags an
 * attached camera's frames with a channel other than the one that was started — without it such a camera
 * would get a stream that never delivers.
 *
 * The hatch's condition was "no frames of my own yet, and 30 for someone else", which is exactly what a
 * station serving one camera at a time produces while it is still serving the previous one. A stream that
 * fired it adopted its sibling's video AND audio permanently, because the tolerance is shared and clearing
 * the channel is not reversible. What separates the two cases is whether anybody STARTED the channel the
 * frames are tagged with: media for a channel a sibling started is contention, not mis-tagging.
 */
class FakeSession extends EventEmitter {
  /** Channels a live start has been issued for on this station, as the real session records them. */
  private readonly liveMediaChannels = new Set<number>();

  startLiveMedia(channel?: number): void {
    this.liveMediaChannels.add(channel ?? 0);
  }

  stopLiveMedia(channel?: number): void {
    this.liveMediaChannels.delete(channel ?? 0);
  }

  startedLiveMedia(channel: number): boolean {
    return this.liveMediaChannels.has(channel);
  }

  decodeVideoFrame(data: Buffer, _signCode: number): Buffer | undefined {
    const declared = data.readUInt32LE(0);
    return data.subarray(22, 22 + declared);
  }

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

/** A stream for `channel` on a station where `alsoStarted` channels have live starts outstanding. */
function attachedStream(channel: number, alsoStarted: readonly number[] = []) {
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
  for (const other of alsoStarted) session.startLiveMedia(other);
  return { session, stream, video, audio };
}

/** More foreign frames than any tolerance, which is what a handover delivers before the sibling stops. */
const PAST_TOLERANCE = 60;

describe("a starting stream beside a sibling on the same station", () => {
  it("delivers none of the sibling's video, however long the station keeps serving it", () => {
    const { session, video } = attachedStream(1, [0]);
    for (let i = 0; i < PAST_TOLERANCE; i++) session.push(videoFrame(0));
    expect(video).toHaveLength(0);
  });

  it("delivers none of the sibling's audio either", () => {
    const { session, audio } = attachedStream(1, [0]);
    for (let i = 0; i < PAST_TOLERANCE; i++) session.push(audioFrame(0));
    expect(audio).toHaveLength(0);
  });

  it("still delivers its own media once the station switches to it", () => {
    const { session, video } = attachedStream(1, [0]);
    for (let i = 0; i < PAST_TOLERANCE; i++) session.push(videoFrame(0));
    session.push(videoFrame(1));
    expect(video).toHaveLength(1);
  });

  /**
   * A sibling that has stopped can still have frames in flight, and the channel it started is gone by then.
   * Those must not reopen the hatch either: this stream has already had its own frames, which is the older
   * of the two guards and the one that does not depend on what the station is doing now.
   */
  it("keeps filtering after a sibling stops, once it has media of its own", () => {
    const { session, video } = attachedStream(1, [0]);
    session.push(videoFrame(1));
    session.stopLiveMedia(0);
    for (let i = 0; i < PAST_TOLERANCE; i++) session.push(videoFrame(0));
    expect(video).toHaveLength(1);
  });
});

/**
 * The hatch itself, which still has to work: a station tagging an attached camera's frames with a channel
 * NOBODY started is mis-tagging, and a stream that kept filtering there would never deliver anything.
 */
describe("a station that tags media with a channel nobody started", () => {
  it("takes the media rather than delivering nothing", () => {
    const { session, video } = attachedStream(1);
    for (let i = 0; i < PAST_TOLERANCE; i++) session.push(videoFrame(7));
    expect(video.length).toBeGreaterThan(0);
  });

  it("tolerates a short burst before concluding it, so a late own frame still wins", () => {
    const { session, video } = attachedStream(1);
    session.push(videoFrame(7));
    session.push(videoFrame(1));
    expect(video).toHaveLength(1);
  });
});
