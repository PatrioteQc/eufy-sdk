/**
 * Camera **media** operations over P2P — snapshot (stored + live), live stream, clip recording.
 *
 * These are the bodies that used to live on `EufyMega`; they take an already-resolved
 * {@link P2PSession} (the client owns session/channel resolution) and return data. They speak only
 * P2P + ffmpeg — no dependency on the client class — so the client stays thin and this stays the
 * single home for the media protocol. Surfaced to consumers via `device.camera()`.
 *
 * `snapshotLive` / `record` require `ffmpeg` on PATH.
 *
 * @module p2p/media
 */
import { P2PSession } from "./p2p-session.js";
import { LiveStream, type LiveStreamOptions } from "./live-stream.js";
import { sniffAnnexbCodec } from "./annexb.js";
import { spawnFfmpeg, type FfmpegLevel } from "../ffmpeg.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { SnapshotUnavailableError } from "../../core/contracts.js";
import type { SharedLiveSource } from "./shared-live-source.js";
import type { LiveVideoFrame } from "../../core/contracts.js";

/**
 * The three steps {@link snapshotWithFallback} orchestrates, injected so the fallback policy can be
 * unit-tested without a live session: `connect` resolves the P2P session (a failure ⇒ the camera is
 * unreachable → `"offline"`); `stored` fetches the latest stored still; `live` decodes a still from a
 * live burst. The router supplies the real implementations (`resolveSession` / `fetchStoredSnapshot` /
 * `captureSnapshotFromShared`).
 */
export interface SnapshotSteps {
  connect(): Promise<{ session: P2PSession; accountId: string }>;
  stored(resolved: { session: P2PSession; accountId: string }): Promise<{ file: string; jpeg: Buffer }>;
  live(): Promise<{ jpeg: Buffer }>;
}

/**
 * Return a real still or throw — never a placeholder. Tries the **stored** still first (cheap, no
 * pull); when the device is reachable but has no stored still (or the stored fetch fails), falls back
 * to a **live burst** (reusing a warm shared pull). `file` is the stored path, or `""` when the JPEG is
 * live-derived. Throws {@link SnapshotUnavailableError} with `reason:"offline"` when the session won't
 * resolve, or `"no-still"` when the device is reachable but neither path yields a frame. A host maps the
 * reason to its own presentation (e.g. a placeholder image) — the SDK stays representation-agnostic.
 */
export { DEFAULT_SNAPSHOT_CACHE_MS } from "../../core/contracts.js";

/** A still + when it was captured (ms epoch), the unit the snapshot TTL cache stores. */
export type CachedSnapshot = { at: number; result: { file: string; jpeg: Buffer } };

/**
 * Per-serial snapshot state: the last still (for the TTL cache) and any in-flight fetch (for
 * coalescing). Held by the transport across `snapshot()` calls (the bound provider is recreated per
 * `getDevice`, so this state must live on the long-lived router, not the provider closure).
 */
export interface SnapshotCacheState {
  cache: Map<string, CachedSnapshot>;
  inflight: Map<string, Promise<{ file: string; jpeg: Buffer }>>;
}

/** Fresh, empty {@link SnapshotCacheState} — one per router. */
export function makeSnapshotCacheState(): SnapshotCacheState {
  return { cache: new Map(), inflight: new Map() };
}

/**
 * Wrap a snapshot `fetch` with a short-TTL cache + concurrency coalescing, so a caller that polls a
 * still every few seconds doesn't wake a battery camera each time. Returns the cached still when it's
 * younger than `ttlMs`; otherwise reuses an in-flight fetch for the same serial, or starts one. Only
 * SUCCESSES are cached — a failed fetch is never stored (a transiently-offline camera must be retried,
 * not pinned "unavailable"). `ttlMs <= 0` bypasses the cache but STILL coalesces concurrent calls (two
 * simultaneous polls never open two pulls). `now` is injectable for deterministic tests; `logger` emits
 * `[snapshot]` debug traces (cache hit / coalesced / fetch) for troubleshooting a polling caller.
 */
export function cachedSnapshot(
  state: SnapshotCacheState,
  sn: string,
  ttlMs: number,
  fetch: () => Promise<{ file: string; jpeg: Buffer }>,
  now: () => number = Date.now,
  logger: Logger = noopLogger,
): Promise<{ file: string; jpeg: Buffer }> {
  if (ttlMs > 0) {
    const hit = state.cache.get(sn);
    if (hit && now() - hit.at < ttlMs) {
      logger.debug(`[snapshot] ${sn}: cache hit (age ${now() - hit.at}ms < ttl ${ttlMs}ms)`);
      return Promise.resolve(hit.result);
    }
  }
  const inflight = state.inflight.get(sn);
  if (inflight) {
    logger.debug(`[snapshot] ${sn}: coalesced onto the in-flight fetch`);
    return inflight;
  }
  logger.debug(`[snapshot] ${sn}: fetching (ttl ${ttlMs}ms)`);
  const p = fetch()
    .then((result) => {
      if (ttlMs > 0) state.cache.set(sn, { at: now(), result });
      return result;
    })
    .finally(() => state.inflight.delete(sn));
  state.inflight.set(sn, p);
  return p;
}

export async function snapshotWithFallback(
  sn: string,
  steps: SnapshotSteps,
  logger: Logger = noopLogger,
): Promise<{ file: string; jpeg: Buffer }> {
  const resolved = await steps.connect().catch((e: unknown) => {
    logger.debug(`[snapshot] ${sn}: session did not resolve — unavailable (offline)`);
    throw new SnapshotUnavailableError("offline", `snapshot: camera ${sn} is unreachable`, { cause: e });
  });
  try {
    return await steps.stored(resolved);
  } catch {
    logger.debug(`[snapshot] ${sn}: no stored still — falling back to a live burst`);
    try {
      const { jpeg } = await steps.live();
      return { file: "", jpeg };
    } catch (liveErr) {
      logger.debug(`[snapshot] ${sn}: live burst produced no frame — unavailable (no-still)`);
      throw new SnapshotUnavailableError(
        "no-still",
        `snapshot: camera ${sn} has no stored still and a live capture produced no frame`,
        { cause: liveErr },
      );
    }
  }
}

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
 * **Stored snapshot** — the latest event thumbnail: query `history_record_info` (inner cmd 10013)
 * for this camera's stored crop path, then fetch + decode the JPEG (surfaced already-decoded via
 * the session `image` event). The app fetches snapshot files on mChannel 0.
 */
export async function fetchStoredSnapshot(
  session: P2PSession,
  sn: string,
  accountId: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ file: string; jpeg: Buffer }> {
  const timeoutMs = opts.timeoutMs ?? 15000;

  // 1. latest snapshot path for this camera (history_record_info, inner cmd 10013)
  const file = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for snapshot path of ${sn}`));
    }, timeoutMs);
    const onData = (f: { json?: unknown }) => {
      const j = f.json as { cmd?: number; data?: Array<{ device_sn?: string; payload?: Record<string, unknown> }> };
      if (j?.cmd === 10013 && Array.isArray(j.data)) {
        const row = j.data.find((d) => d.device_sn === sn);
        const p = row?.payload?.crop_hb3_path as string | undefined;
        if (p) {
          cleanup();
          resolve(p);
        } else if (row) {
          cleanup();
          reject(new Error(`no stored snapshot for ${sn} (event_count=${row?.payload?.event_count ?? 0})`));
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      session.off("data", onData);
    };
    session.on("data", onData);
    session.queryDatabase("history_record_info", { accountId, innerCmd: 10013, channel: 255 });
  });

  // 2. fetch + decode the JPEG (surfaced already-decoded via the `image` event)
  const jpeg = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for snapshot image of ${sn}`));
    }, timeoutMs);
    const onImage = (img: { file: string; data: Buffer }) => {
      if (img.data?.length) {
        cleanup();
        resolve(img.data);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      session.off("image", onImage);
    };
    session.on("image", onImage);
    // the app fetches snapshot files on mChannel 0 (not the camera's device_channel)
    session.requestImage(file, { accountId, channel: 0 });
  });

  return { file, jpeg };
}

/**
 * **Live snapshot off a SHARED source** (V6) — snapshot as just another consumer of the shared live
 * pull. If the source is already warm and has a cached keyframe (V2 keyframe-prime), the joining
 * consumer receives that IDR immediately and we decode it with **no extra pull** — a snapshot while
 * someone else watches costs nothing on the wire. Otherwise we warm the source and wait for a clean
 * keyframe (the first IDR after a cold start is frequently partial, so skip it by default). Requires
 * `ffmpeg` for the Annex-B → JPEG decode.
 */
export async function captureSnapshotFromShared(
  source: SharedLiveSource,
  opts: {
    timeoutMs?: number;
    collectMs?: number;
    skipKeyframes?: number;
    logger?: Logger;
    ffmpegLevel?: FfmpegLevel;
  } = {},
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const collectMs = opts.collectMs ?? 1500;
  const skip = opts.skipKeyframes ?? 1;
  const consumer = source.attach();
  // A primed consumer gets the cached IDR first — a single decodable keyframe: take it and decode at
  // once (no skip, no collect window). A cold consumer skips the (often partial) first IDR.
  const primed = consumer.primed;
  try {
    const { h264, width, height } = await new Promise<{ h264: Buffer; width: number; height: number }>(
      (resolve, reject) => {
        const bufs: Buffer[] = [];
        let keyCount = 0,
          capturing = false,
          w = 0,
          h = 0,
          settle: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("timeout waiting for a clean keyframe"));
        }, timeoutMs);
        const onVideo = (fr: LiveVideoFrame) => {
          if (fr.keyframe) keyCount++;
          if (!capturing) {
            const threshold = primed ? 0 : skip; // primed: accept the cached IDR immediately
            if (!fr.keyframe || keyCount <= threshold) return;
            capturing = true;
            w = fr.width;
            h = fr.height;
          }
          bufs.push(fr.data);
          if (!settle)
            settle = setTimeout(
              () => {
                cleanup();
                resolve({ h264: Buffer.concat(bufs), width: w, height: h });
              },
              primed ? 0 : collectMs,
            );
        };
        const cleanup = () => {
          clearTimeout(timer);
          if (settle) clearTimeout(settle);
          consumer.off("video", onVideo);
        };
        consumer.on("video", onVideo);
        consumer.on("error", () => {});
      },
    );
    const jpeg = await annexbToJpeg(h264, opts.logger ?? noopLogger, opts.ffmpegLevel);
    return { jpeg, width, height };
  } finally {
    consumer.detach();
  }
}

/**
 * **Record** a clip — collect the live H.264/H.265 stream for `seconds` and mux it to a fragmented
 * MP4 (same source as {@link captureSnapshotFromShared}, kept running and written to a container).
 * Recording starts at the first complete keyframe so the clip is seekable. Requires `ffmpeg`.
 */
export async function recordClip(
  session: P2PSession,
  seconds: number,
  opts: {
    timeoutMs?: number;
    skipKeyframes?: number;
    logger?: Logger;
    ffmpegLevel?: FfmpegLevel;
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
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout waiting for a clean keyframe"));
      }, timeoutMs);
      const onVideo = (fr: LiveVideoFrame) => {
        if (fr.keyframe) keyCount++;
        if (!capturing) {
          if (!fr.keyframe || keyCount <= skip) return; // start the clip at the first COMPLETE keyframe
          capturing = true;
          clearTimeout(timer);
          stopAt = Date.now() + seconds * 1000;
        }
        bufs.push(fr.data);
        if (Date.now() >= stopAt) {
          cleanup();
          resolve(Buffer.concat(bufs));
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
      { logger: opts.logger, level: opts.ffmpegLevel },
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

/** Decode an Annex-B buffer (H.264 or H.265, starting at a keyframe) to a single JPEG via ffmpeg. */
function annexbToJpeg(annexb: Buffer, logger: Logger = noopLogger, level?: FfmpegLevel): Promise<Buffer> {
  const codec = annexbFfmpegFormat(annexb);
  return new Promise<Buffer>((resolve, reject) => {
    const ff = spawnFfmpeg(
      [
        // prettier-ignore
        "-f",
        codec,
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      { logger, level },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout!.on("data", (d) => out.push(d));
    ff.stderr!.on("data", (d) => err.push(d));
    ff.on("error", (e) =>
      reject(new Error(`ffmpeg not runnable (is it installed?): ${e instanceof Error ? e.message : e}`)),
    );
    ff.on("close", (code) => {
      const jpeg = Buffer.concat(out);
      if (jpeg.length >= 3 && jpeg.subarray(0, 3).toString("hex") === "ffd8ff") resolve(jpeg);
      else
        reject(new Error(`ffmpeg JPEG decode failed (code ${code}): ${Buffer.concat(err).toString().slice(0, 200)}`));
    });
    ff.stdin!.on("error", () => {});
    ff.stdin!.write(annexb);
    ff.stdin!.end();
  });
}
