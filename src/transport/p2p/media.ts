/**
 * Camera **media** operations over P2P — live snapshot, live stream, clip recording.
 *
 * These are the bodies that used to live on `EufyMega`; they take an already-resolved
 * {@link P2PSession} (the client owns session/channel resolution) and return data. They speak only
 * P2P + ffmpeg — no dependency on the client class — so the client stays thin and this stays the
 * single home for the media protocol. Surfaced to consumers via `device.camera()`.
 *
 * `snapshotLive` / `record` shell out to ffmpeg. The binary is whatever {@link spawnFfmpeg} resolves —
 * the bare name on `PATH` by default, or the executable the caller named (`ffmpegPath`).
 *
 * @module p2p/media
 */
import { P2PSession } from "./p2p-session.js";
import { LiveStream, type LiveStreamOptions } from "./live-stream.js";
import { prefixParamSets, sniffAnnexbCodec, updatedParamSets, type ParamSets } from "./annexb.js";
import { spawnFfmpeg, type FfmpegLevel, type FfmpegSpawnOptions } from "../ffmpeg.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import type { SharedLiveSource } from "./shared-live-source.js";
import { LiveSnapshotUnavailableError, type LiveVideoFrame, type VideoCodec } from "../../core/contracts.js";

/**
 * ffmpeg's `-f` demuxer name for an Annex-B buffer. Sniffs via the shared {@link sniffAnnexbCodec}
 * (the single NAL-scan source of truth) and maps the contract's `"h265"` to ffmpeg's `"hevc"`;
 * defaults to `"h264"` when the buffer carries no config NAL to sniff.
 */
function annexbFfmpegFormat(buf: Buffer): "hevc" | "h264" {
  return sniffAnnexbCodec(buf) === "h265" ? "hevc" : "h264";
}

/**
 * Open a managed **live stream** on an already-connected session. Returns the {@link LiveStream}
 * already `start()`ed; call `.stop()` when done. (Session/channel/level-2-key resolution is the
 * caller's job — see `EufyMega.resolveSession`.)
 */
export async function openLiveStream(session: P2PSession, opts: LiveStreamOptions = {}): Promise<LiveStream> {
  return new LiveStream(session, opts).start();
}

/**
 * **Live snapshot off a SHARED source** (V6) — snapshot as just another consumer of the shared live
 * pull. If the source is already warm and has a cached keyframe (V2 keyframe-prime), the joining
 * consumer receives that IDR immediately and we decode it with **no extra pull** — a snapshot while
 * someone else watches costs nothing on the wire. Otherwise we warm the source and wait for a clean
 * keyframe (the first IDR after a cold start is frequently partial, so skip it by default). Requires
 * `ffmpeg` for the Annex-B → JPEG decode.
 *
 * The returned dimensions are the ENCODED IMAGE's own, read back out of it — never the frame header's.
 * The header states the stream's geometry when the capture started, and a stream that reconfigures
 * mid-burst leaves it describing something the returned bytes contradict; the return value describes an
 * image, so the image is its source of truth.
 */
export async function captureSnapshotFromShared(
  source: SharedLiveSource,
  opts: {
    timeoutMs?: number;
    collectMs?: number;
    skipKeyframes?: number;
    logger?: Logger;
    ffmpegLevel?: FfmpegLevel;
    ffmpegPath?: string;
  } = {},
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const collectMs = opts.collectMs ?? 1500;
  const skip = opts.skipKeyframes ?? 1;
  const consumer = source.attach("snapshot");
  // A primed consumer gets the cached IDR first — a single decodable keyframe: take it and decode at
  // once (no skip, no collect window). A cold consumer skips the (often partial) first IDR.
  const primed = consumer.primed;
  try {
    const burst = await new Promise<{
      h264: Buffer;
      codec: VideoCodec;
      sets?: ParamSets;
    }>((resolve, reject) => {
      const bufs: Buffer[] = [];
      let sets = source.parameterSets;
      let codec: VideoCodec = "h264";
      let keyCount = 0,
        capturing = false,
        settle: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new LiveSnapshotUnavailableError(
            "no-keyframe",
            `no clean keyframe within ${timeoutMs}ms (source state: ${source.state})`,
          ),
        );
      }, timeoutMs);
      const onVideo = (fr: LiveVideoFrame) => {
        sets = updatedParamSets(fr.data, sets);
        if (fr.keyframe) keyCount++;
        if (!capturing) {
          const threshold = primed ? 0 : skip; // primed: accept the cached IDR immediately
          if (!fr.keyframe || keyCount <= threshold) return;
          capturing = true;
          codec = fr.codec;
        }
        bufs.push(fr.data);
        if (!settle)
          settle = setTimeout(
            () => {
              cleanup();
              resolve({ h264: Buffer.concat(bufs), codec, sets });
            },
            primed ? 0 : collectMs,
          );
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new LiveSnapshotUnavailableError("source-failed", err.message, { cause: err }));
      };
      const cleanup = () => {
        clearTimeout(timer);
        if (settle) clearTimeout(settle);
        consumer.off("video", onVideo);
        consumer.off("error", onError);
      };
      consumer.on("video", onVideo);
      consumer.on("error", onError);
    });
    return await annexbToJpeg(primeForDecode(burst.h264, burst.sets, burst.codec), {
      logger: opts.logger ?? noopLogger,
      level: opts.ffmpegLevel,
      executable: opts.ffmpegPath,
    });
  } finally {
    consumer.detach();
  }
}

/**
 * **Record** a clip — collect the live H.264/H.265 stream for `seconds` and mux it to a fragmented
 * MP4 (same source as {@link captureSnapshotFromShared}, kept running and written to a container).
 * Recording starts at the first complete keyframe so the clip is seekable. Requires `ffmpeg`.
 *
 * Opens its OWN {@link LiveStream} over the session rather than joining the device's shared source, so it
 * costs a second pull on a camera already streaming, and the shared path's release of a sibling's lingering
 * pull does not reach it. `recordFragments` is the shared-consumer path.
 *
 * The clip therefore starts at the SECOND keyframe, so parameter sets announced only with the first are
 * dropped along with it — every frame is watched for an announcement, including the skipped ones, and
 * the collected run is primed before muxing. This also settles the codec, which is sniffed from a config NAL:
 * a run of bare slices would otherwise fall back to H.264 and mislabel an H.265 clip.
 */
export async function recordClip(
  session: P2PSession,
  seconds: number,
  opts: {
    timeoutMs?: number;
    skipKeyframes?: number;
    logger?: Logger;
    ffmpegLevel?: FfmpegLevel;
    ffmpegPath?: string;
  } & LiveStreamOptions = {},
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const skip = opts.skipKeyframes ?? 1;
  const stream = await openLiveStream(session, opts);
  let h264: Buffer;
  try {
    h264 = await new Promise<Buffer>((resolve, reject) => {
      const bufs: Buffer[] = [];
      let keyCount = 0,
        capturing = false,
        stopAt = 0;
      let sets: ParamSets | undefined;
      let codec: VideoCodec = "h264";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout waiting for a clean keyframe"));
      }, timeoutMs);
      const onVideo = (fr: LiveVideoFrame) => {
        sets = updatedParamSets(fr.data, sets);
        if (fr.keyframe) keyCount++;
        if (!capturing) {
          if (!fr.keyframe || keyCount <= skip) return; // start the clip at the first COMPLETE keyframe
          capturing = true;
          codec = fr.codec;
          clearTimeout(timer);
          stopAt = Date.now() + seconds * 1000;
        }
        bufs.push(fr.data);
        if (Date.now() >= stopAt) {
          cleanup();
          resolve(primeForDecode(Buffer.concat(bufs), sets, codec));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        stream.off("video", onVideo);
      };
      stream.on("video", onVideo);
      stream.on("error", () => {});
    });
  } finally {
    stream.stop();
  }
  // mux the elementary stream (codec auto-detected) into a fragmented MP4
  const codec = annexbFfmpegFormat(h264);
  return new Promise<Buffer>((resolve, reject) => {
    const ff = spawnFfmpeg(
      [
        // prettier-ignore
        "-f",
        codec,
        "-i",
        "pipe:0",
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
      ],
      { logger: opts.logger, level: opts.ffmpegLevel, executable: opts.ffmpegPath },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout!.on("data", (d) => out.push(d));
    ff.stderr!.on("data", (d) => err.push(d));
    ff.on("error", (e) => reject(new Error(`ffmpeg not runnable: ${e instanceof Error ? e.message : e}`)));
    ff.on("close", (code) => {
      const mp4 = Buffer.concat(out);
      if (mp4.length) resolve(mp4);
      else reject(new Error(`ffmpeg mux failed (code ${code}): ${Buffer.concat(err).toString().slice(0, 200)}`));
    });
    ff.stdin!.on("error", () => {});
    ff.stdin!.write(h264);
    ff.stdin!.end();
  });
}

/**
 * Make a collected burst decodable on its own by re-emitting the stream's parameter sets ahead of it.
 *
 * A camera commonly announces SPS/PPS ONCE, with the first keyframe of a stream. A snapshot skips that
 * first (often partial) IDR by default and a consumer joining a warm source never sees it at all, so a
 * collected burst routinely begins after the only announcement. A decoder with no SPS/PPS for its first
 * slices refuses the burst with `non-existing PPS 0 referenced`, so whether such an attempt yields an
 * image depends on where in the stream it happened to land. Re-emitting the sets makes it independent of
 * that.
 *
 * Primes unconditionally rather than only when the burst looks incomplete. Re-announcing a set a decoder
 * already holds is harmless — it overwrites the entry with the same id — while judging completeness is
 * not: a unit carrying an SPS but no PPS, or H.265 SPS+PPS but no VPS, reads as self-contained by any
 * cheap test and is precisely a burst that cannot decode alone.
 *
 * `codec` guards the one substitution that would be worse than none: sets from a different codec are
 * parameter sets the burst's decoder cannot use. Without sets, or on a mismatch, the burst passes through
 * unchanged so it fails with the decoder's own reason rather than a fabricated one.
 */
function primeForDecode(burst: Buffer, sets: ParamSets | undefined, codec: VideoCodec): Buffer {
  return sets && sets.codec === codec ? prefixParamSets(burst, sets) : burst;
}

/** Marker bytes that stand alone: TEM, SOI, EOI and the eight restart markers carry no length field. */
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

/** Marker bytes in the `SOFn` range that are NOT frame headers: DHT, JPG and DAC share it. */
const JPEG_NOT_FRAME_HEADERS = new Set([0xc4, 0xc8, 0xcc]);

/**
 * The geometry a JPEG declares in its own frame header (`SOFn`), or `undefined` when it carries none.
 *
 * Walks the marker segments from the SOI rather than searching for the marker bytes: a `0xffc0` pair
 * occurs inside quantization tables and entropy-coded data, and the first one found there would answer
 * with two bytes of image content. Every `SOFn` puts precision, then height, then width at the same
 * offset past its length field, so one read serves all of them. Any number of `0xff` fill bytes may
 * precede a marker, and the standalone markers carry no length to skip by — both are what a naive walk
 * gets wrong, and either would make a perfectly good image read as having no geometry.
 *
 * Decoding the image (the `jpeg-js` path the v2 thumbnail decoder needs) would answer the same question,
 * but it is synchronous pure JS over every pixel: this needs a dozen bytes of header, so it reads them.
 */
function jpegGeometry(jpeg: Buffer): { width: number; height: number } | undefined {
  let at = 2;
  while (at + 1 < jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NOT_FRAME_HEADERS.has(marker)) {
      if (at + 9 > jpeg.length) return undefined;
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    if (JPEG_STANDALONE_MARKERS.has(marker)) at += 2;
    else if (at + 4 <= jpeg.length) at += 2 + jpeg.readUInt16BE(at + 2);
    else return undefined;
  }
  return undefined;
}

/**
 * Decode an Annex-B buffer (H.264 or H.265, starting at a keyframe) to a single JPEG via ffmpeg, with
 * the geometry read back out of the image the encoder produced.
 *
 * `-pix_fmt yuvj420p` pins the JPEG-range output the encoder requires. Camera streams signal limited
 * ("tv") range, and the mjpeg encoder refuses a non-full-range input under default compliance — whether
 * it sees one depends on which pixel format format-negotiation happens to settle on, so leaving it
 * unpinned makes the decode fail on some bursts and not others from the same camera. Verified against a
 * captured live burst: the flag produces byte-identical output where negotiation already chose this
 * format, so it constrains only the case that would otherwise error.
 *
 * A burst can also yield no image while ffmpeg exits 0 — asked for one frame, it finds no complete frame
 * in the data and reports success having encoded none. That is a property of the burst, so it carries the
 * same reason as a refused one, but it is described as such rather than as an ffmpeg failure. Bytes that
 * pass the SOI check but declare no frame header land there too: they describe no geometry, and answering
 * with the stream's would reinstate the disagreement reading it back exists to remove.
 *
 * `spawn` carries the ffmpeg dials straight through to {@link spawnFfmpeg} — they are its options, not this
 * function's, so they travel as one bag rather than accumulating as positionals here.
 */
function annexbToJpeg(
  annexb: Buffer,
  spawn: FfmpegSpawnOptions,
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const codec = annexbFfmpegFormat(annexb);
  return new Promise<{ jpeg: Buffer; width: number; height: number }>((resolve, reject) => {
    const ff = spawnFfmpeg(
      [
        // prettier-ignore
        "-f",
        codec,
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuvj420p",
        "-f",
        "image2",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      spawn,
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout!.on("data", (d) => out.push(d));
    ff.stderr!.on("data", (d) => err.push(d));
    ff.on("error", (e) =>
      reject(
        new LiveSnapshotUnavailableError(
          "decoder-unavailable",
          `ffmpeg not runnable: ${e instanceof Error ? e.message : e}`,
          { cause: e },
        ),
      ),
    );
    ff.on("close", (code) => {
      const jpeg = Buffer.concat(out);
      const encoded = jpeg.length >= 3 && jpeg.subarray(0, 3).toString("hex") === "ffd8ff";
      const geometry = encoded ? jpegGeometry(jpeg) : undefined;
      if (geometry) return resolve({ jpeg, ...geometry });
      const diagnostics = Buffer.concat(err).toString().slice(0, 200).trim();
      const what =
        code !== 0
          ? `ffmpeg exited ${code}`
          : encoded
            ? "encoded image declares no frame header"
            : "no complete frame in the burst";
      reject(new LiveSnapshotUnavailableError("undecodable-burst", diagnostics ? `${what}: ${diagnostics}` : what));
    });
    ff.stdin!.on("error", () => {});
    ff.stdin!.write(annexb);
    ff.stdin!.end();
  });
}
