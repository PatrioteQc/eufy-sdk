/**
 * Managed realtime live stream over P2P — turns a station's `CMD_VIDEO_FRAME` (1300) /
 * `CMD_AUDIO_FRAME` (1301) frames into a clean, continuous **Annex-B H.264** (+ audio) feed that a
 * downstream muxer (go2rtc / ffmpeg) can ingest and serve as WebRTC / RTSP / HLS.
 *
 * Two video frame variants are handled:
 *  - **Plaintext** (`signCode 0`, e.g. HomeBase-attached cameras): a fixed 22-byte frame header
 *    (`parseVideoFrameHeader`) followed directly by Annex-B NAL units — verified live (960×540,
 *    keyframe = header flag bit0). We strip the 22-byte header.
 *  - **Encrypted** (E2E cameras): the body is AES-256-GCM under a per-stream media key wrapped in a
 *    keyframe ECIES envelope. If an `eccPrivateKey` is supplied we run `VideoFrameDecoder`; otherwise
 *    those frames are skipped (no key → no video).
 *
 * Emits: `video` ({@link LiveVideoFrame} — Annex-B), `audio` (Buffer), `start`, `stop`, `error`.
 */
import { EventEmitter } from "node:events";
import type { P2PSession, P2PFrame } from "./p2p-session.js";
import { parseVideoFrameHeader, VideoFrameDecoder } from "./video.js";
import { sniffAnnexbCodec } from "./annexb.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import type { LiveVideoFrame, VideoCodec } from "../../core/contracts.js";

const CMD_VIDEO_FRAME = 1300;
const CMD_AUDIO_FRAME = 1301;
const VIDEO_HEADER_LEN = 0x16; // 22-byte CMD_VIDEO_FRAME header before the Annex-B payload
const AUDIO_HEADER_LEN = 0x10; // 16-byte CMD_AUDIO_FRAME header before the audio payload
const SC4 = Buffer.from([0, 0, 0, 1]);
const SC3 = Buffer.from([0, 0, 1]);

/**
 * How often the media start is re-issued to hold a stream open, when a caller expresses no preference.
 *
 * This is **on by default** because some cameras stop sending without it. With the nudge disabled, a
 * T8170 went quiet 13.6 s into a plain `live()` — no `stop`, no `error`, the feed simply stopped — and
 * ran the full window with it on (185 frames vs 704 over 40 s).
 *
 * Which cameras need it does **not** follow topology or power source, so there is no predicate to gate
 * it on: measured across four cameras, an own-session T8410 and both HomeBase-attached cameras (T8210,
 * T8114) held a 40 s stream up with the nudge disabled, while the own-session T8170 did not. All four
 * are battery. Since a camera that needs it goes silent rather than reporting anything, the default
 * covers the one that fails.
 *
 * What the nudge costs differs by topology, and only one branch is a true keepalive: an own-session
 * camera's `startLiveMedia` tracks that the stream is already started and sends the small ping, while a
 * HomeBase-attached camera has no such state and re-sends the full media start — a genuine restart on
 * that path. Measured, that restart is not harmful at this interval: both attached cameras streamed a
 * 40 s window with and without it at the same frame rate (15.6–16.9 fps either way) and with no stall
 * either way.
 */
export const DEFAULT_KEEPALIVE_MS = 3000;

export interface LiveStreamOptions {
  /**
   * Camera channel to START (the device's `device_channel`) — sent in CMD_START_REALTIME_MEDIA to
   * select which camera on a multi-camera HomeBase streams. Defaults to the station channel.
   * NOTE: this is the SEND channel; inbound frames are tagged channel 0 by the station regardless,
   * so it is NOT used to filter received frames.
   */
  channel?: number;
  /** Camera ECC private key (32B) for E2E/encrypted cameras; omit for plaintext cameras. */
  eccPrivateKey?: Buffer;
  /** Admin account id — required for the level-2 (`signCode 8`) media-start payload selecting a camera. */
  accountId?: string;
  /**
   * Re-send the media start every N ms to hold the stream open. Defaults to
   * {@link DEFAULT_KEEPALIVE_MS}; pass `0` to disable.
   */
  keepAliveMs?: number;
  /**
   * Runtime topology fact (from the device record: `parent_sn && parent_sn !== sn`): true = the camera
   * rides a HomeBase's session (start via the level-2 `1003` payload), false = own-session camera
   * (start via the `1700`/`cmd 1000` path, level-2 or level-1 per the session key). NOT a family trait.
   */
  homeBaseAttached?: boolean;
  /** Diagnostics sink. Omit for silence. */
  logger?: Logger;
}

export class LiveStream extends EventEmitter {
  private listening = false;
  private decoder?: VideoFrameDecoder;
  private kaTimer?: ReturnType<typeof setInterval>;
  /** Last codec sniffed off a keyframe; delta frames (no config NAL) inherit it. Default h264. */
  private lastCodec: VideoCodec = "h264";
  private readonly handler = (f: P2PFrame) => this.onFrame(f);
  private readonly logger: Logger;

  constructor(
    private readonly session: P2PSession,
    private readonly opts: LiveStreamOptions = {},
  ) {
    super();
    this.logger = opts.logger ?? noopLogger;
    if (opts.eccPrivateKey) this.decoder = new VideoFrameDecoder(opts.eccPrivateKey);
  }

  /** Begin streaming: attach the frame listener and tell the station to start realtime media. */
  start(): this {
    if (this.listening) return this;
    this.listening = true;
    this.session.on("data", this.handler);
    this.sendStart();
    const keepAliveMs = this.opts.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
    if (keepAliveMs > 0) {
      this.kaTimer = setInterval(() => this.sendStart(), keepAliveMs);
    }
    this.emit("start");
    return this;
  }

  /**
   * Re-issue the start command (idempotent while listening) — the media-start / keepalive nudge. The
   * shared source calls this to retry a start that raced key negotiation, until frames flow. Safe to
   * call repeatedly: `startLiveMedia` self-selects start vs keepalive per the session state.
   */
  nudge(): void {
    if (this.listening) this.sendStart();
  }

  private sendStart(): void {
    try {
      this.session.startLiveMedia(this.opts.channel, this.opts.accountId, this.opts.homeBaseAttached);
    } catch (e) {
      // Non-fatal: the session may be mid-reconnect; the warm-up retry will re-issue the start.
      this.logger.debug(`[live] startLiveMedia deferred (session not ready): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Stop streaming: detach the listener and tell the station to stop. Idempotent. */
  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.session.off("data", this.handler);
    if (this.kaTimer) clearInterval(this.kaTimer);
    this.kaTimer = undefined;
    try {
      this.session.stopLiveMedia(this.opts.channel, this.opts.accountId);
    } catch (e) {
      this.logger.debug(`[live] stopLiveMedia ignored: ${e instanceof Error ? e.message : e}`);
    }
    this.emit("stop");
  }

  /** Extract the Annex-B payload from a plaintext 1300 frame (fixed 22-byte header), or undefined. */
  private plaintextAnnexB(d: Buffer): Buffer | undefined {
    if (d.length > VIDEO_HEADER_LEN) {
      const body = d.subarray(VIDEO_HEADER_LEN);
      // Plaintext frames begin with a NAL start code immediately after the 22-byte header.
      if (body.length >= 4 && (body.subarray(0, 4).equals(SC4) || body.subarray(0, 3).equals(SC3))) {
        return body;
      }
    }
    return undefined;
  }

  private onFrame(f: P2PFrame): void {
    // NOTE: no channel filter here — the station tags inbound media frames channel 0 regardless of
    // which camera channel was started, so filtering by `opts.channel` would drop everything. One
    // LiveStream maps to one started camera; emit all video/audio frames it receives.
    try {
      if (f.commandId === CMD_VIDEO_FRAME) {
        const hdr = parseVideoFrameHeader(f.data);
        // Standard path (plaintext + RSA/AES-ECB encrypted keyframes): the session decodes it (it
        // holds the RSA private key). Falls back to the legacy header-strip + ECIES VideoFrameDecoder.
        let annexb = this.session.decodeVideoFrame?.(f.data, f.signCode) ?? this.plaintextAnnexB(f.data);
        if (!annexb && this.decoder) {
          const dec = this.decoder.decodeFrame(f.data); // E2E ECIES-camera path
          if (dec) annexb = dec.h264;
        }
        if (annexb && annexb.length) {
          const keyframe = hdr?.keyframe ?? false;
          // Sniff the codec only on a keyframe (it carries the parameter sets); delta frames have no
          // config NAL, so they inherit the last-known codec.
          if (keyframe) this.lastCodec = sniffAnnexbCodec(annexb) ?? this.lastCodec;
          this.emit("video", {
            keyframe,
            width: hdr?.width ?? 0,
            height: hdr?.height ?? 0,
            codec: this.lastCodec,
            data: annexb,
          });
        }
      } else if (f.commandId === CMD_AUDIO_FRAME) {
        const audio = f.data.length > AUDIO_HEADER_LEN ? f.data.subarray(AUDIO_HEADER_LEN) : f.data;
        if (audio.length) this.emit("audio", audio);
      }
    } catch (e) {
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export interface LiveStream {
  on(event: "video", listener: (frame: LiveVideoFrame) => void): this;
  on(event: "audio", listener: (data: Buffer) => void): this;
  on(event: "start" | "stop", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  // Structural conformance to LiveStreamHandle; the upstream stream never emits "budget" itself
  // (the shared source raises it on the consumer side), but the type must be assignable.
  on(event: "budget", listener: (notice: import("../../core/contracts.js").StreamBudgetNotice) => void): this;
  emit(event: "video", frame: LiveVideoFrame): boolean;
  emit(event: "audio", data: Buffer): boolean;
  emit(event: "start" | "stop"): boolean;
  emit(event: "error", err: Error): boolean;
}
