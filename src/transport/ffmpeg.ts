/**
 * Shared `ffmpeg` spawn helper — the ONE place that shells out to ffmpeg. It decides ffmpeg's own
 * verbosity, prepends the common flags, and routes stderr into the SDK's {@link Logger}, so no caller
 * touches `spawn("ffmpeg", …)` directly. Used by the media paths that mux via ffmpeg (`p2p/media.ts`
 * snapshot/record, `webrtc/peer.ts` container). Not byte-on-a-wire, so it sits at the transport root
 * rather than in a wire subfolder.
 *
 * Two independent dials:
 *   - **ffmpeg verbosity** — how chatty ffmpeg itself is, via `-loglevel`, from the host's
 *     `new EufyMega({ ffmpegLogLevel })` config (default `"error"`).
 *   - **where it lands** — the host {@link Logger} and its own min-level gate what's actually shown.
 *
 * So `new EufyMega({ ffmpegLogLevel: "trace", logger: new ConsoleLogger() })` surfaces ffmpeg's full
 * trace at `[ffmpeg]` debug lines; the default level + no logger stays silent.
 *
 * @module transport/ffmpeg
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { noopLogger, type Logger } from "../core/logger.js";

/**
 * ffmpeg's `-loglevel` values, quiet → loud. `trace` is the firehose.
 *
 * Exported so a caller can offer the set as data; not published — `FfmpegLevel` is the union a reader
 * of the reference needs, and it states the same members.
 * @internal
 */
export const FFMPEG_LEVELS = [
  "quiet",
  "panic",
  "fatal",
  "error",
  "warning",
  "info",
  "verbose",
  "debug",
  "trace",
] as const;
/** A valid ffmpeg `-loglevel`. Set via `new EufyMega({ ffmpegLogLevel })`. */
export type FfmpegLevel = (typeof FFMPEG_LEVELS)[number];

const isFfmpegLevel = (v: FfmpegLevel | undefined): v is FfmpegLevel =>
  !!v && (FFMPEG_LEVELS as readonly string[]).includes(v);

/**
 * Resolve ffmpeg's own verbosity from the SDK config a host passes (`new EufyMega({ ffmpegLogLevel })`),
 * defaulting to `"error"` (quiet); an unset/invalid value yields the default. This is ffmpeg's
 * `-loglevel`, NOT the SDK's {@link LogLevel} — the two are orthogonal (ffmpeg decides what to emit,
 * the Logger decides what's shown).
 */
export function ffmpegLogLevel(level?: FfmpegLevel): FfmpegLevel {
  return isFfmpegLevel(level) ? level : "error";
}

/**
 * Spawn ffmpeg. Prepends `-hide_banner` + the env-driven `-loglevel` (see {@link ffmpegLogLevel}) to
 * `args`, then forwards the child's stderr to `logger.debug` under an `[ffmpeg]` prefix — the logger's
 * min-level gates visibility, so a `noopLogger` (the default) swallows it. Callers pass only their
 * ffmpeg-specific args and read stdin/stdout off the returned child.
 *
 * `stdio` defaults to all-pipe; pass e.g. `["pipe", "ignore", "pipe"]` to drop stdout (stderr must
 * stay piped for forwarding to work). `level` overrides the resolved `-loglevel` (see
 * {@link ffmpegLogLevel} for precedence).
 */
export function spawnFfmpeg(
  args: string[],
  opts: { logger?: Logger; stdio?: StdioOptions; level?: FfmpegLevel } = {},
): ChildProcess {
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", ffmpegLogLevel(opts.level), ...args], {
    stdio: opts.stdio ?? "pipe",
  });
  ff.stderr?.on("data", (d: Buffer) => {
    const text = d.toString().trimEnd();
    if (text) (opts.logger ?? noopLogger).debug(`[ffmpeg] ${text}`);
  });
  return ff;
}
