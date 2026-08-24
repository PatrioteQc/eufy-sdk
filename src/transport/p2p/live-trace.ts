/**
 * Bounded, identity-free live-startup diagnostics.
 *
 * A live start spans two modules — the session issues the media command and reassembles datagrams, the
 * stream turns accepted frames into access units — so the message and its phase vocabulary have one owner
 * here rather than a literal repeated at each call site. A caller reads these to tell one startup outcome
 * from another, and matches on {@link LIVE_TRACE_MESSAGE} plus a {@link LiveTrace} phase to do it.
 *
 * Every field is a fixed label, a boolean, a data-type id, or a sign code. No serial, P2P identifier,
 * address, account id, key material, or media byte is carried, so the records are safe in a host's log.
 *
 * @module p2p/live-trace
 */
import type { Logger } from "../../core/logger.js";

/** The message every startup trace is logged under. */
export const LIVE_TRACE_MESSAGE = "[live] start trace";

/** One bounded startup observation. */
export type LiveTrace =
  /** A media start or keepalive was sent, with the topology and encryption level it was sent under. */
  | { phase: "media-command"; topology: "attached" | "own"; action: "start" | "keepalive"; level2: boolean }
  /** The device acknowledged a retained start, or that start was repeated / abandoned unacknowledged. */
  | { phase: "media-command-ack" | "media-command-retry" | "media-command-unacknowledged"; action: "start" }
  /** The first inbound video command, and whether this stream's channel filter accepted it. */
  | { phase: "first-video-command"; signCode: number; accepted: boolean }
  /** The first reassembled video access unit, and whether it was decodable on its own. */
  | { phase: "first-video-unit"; keyframe: boolean }
  /** The first keyframe reached the consumer. */
  | { phase: "first-keyframe" }
  /** Media tagged for another camera on the same station arrived first. */
  | { phase: "first-foreign-media-command"; media: "audio" | "video" }
  /** A video payload decoded to nothing, so no access unit could be built from it. */
  | { phase: "video-decode-empty"; signCode: number }
  /** A datagram was missing on a data channel, discarding the logical frame being reassembled. */
  | { phase: "datagram-gap"; dataType: number };

/** Record one startup observation at debug level. */
export function traceLiveStart(logger: Logger, trace: LiveTrace): void {
  logger.debug(LIVE_TRACE_MESSAGE, trace);
}
