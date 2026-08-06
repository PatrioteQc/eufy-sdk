/**
 * eufy "leo_rtc" WebRTC **signaling** wire protocol.
 *
 * Signaling is a proprietary binary protocol over a **TCP** control connection to
 * `webrtc-signal-{region}.eufylife.com` (ThroughTek-style). Each message is a fixed 16-byte
 * little-endian header (the same `XZYH` magic used by the P2P data frames) followed by a
 * `paramLen`-byte body. When `signCode === 1` the body is AES-128-GCM encrypted (see
 * {@link ./crypto}). SDP and ICE candidates ride as base64 strings inside the (encrypted) body
 * of INFO/MSG commands. Media itself is standard DTLS-SRTP WebRTC.
 *
 * Reversed from `libmega_media_sdk.so` (`rtc_notify_read` @0x1fbec4, dispatcher @0x208eac).
 * The exact field layout *inside* each command body still needs a capture to confirm.
 */

/** ASCII "XZYH" as a little-endian u32 (wire bytes `58 5A 59 48`). */
export const SIGNAL_MAGIC = 0x48595a58;
/** Fixed signaling frame header length. */
export const SIGNAL_HEADER_BYTES = 16;

/** Signaling command IDs (dispatcher max = 13). */
export const RtcCommand = {
  LOGIN: 1,
  CALL: 2,
  ANSWER: 3,
  MSG: 4, // trickle ICE candidates ride here
  MSG_ANSWER: 5,
  CMD_MSG: 8,
  CMD_MSG_ANSWER: 9,
  PING: 10,
  INFO: 11, // SDP offer/answer ride here
  HANGUP: 13,
  REPORT: 13,
} as const;
export type RtcCommandId = (typeof RtcCommand)[keyof typeof RtcCommand];

/** `signCode` values in the header. */
export const SignCode = { PLAIN: 0, GCM: 1 } as const;
/** `version` is set to this when the body is GCM-encrypted. */
export const VERSION_GCM = 0x0a;

/** Parsed 16-byte signaling header. */
export interface SignalHeader {
  commandId: number; // u16 @0x04
  paramLen: number; // u32 @0x06 — body length
  version: number; // u8  @0x0A (0x0A when GCM)
  irMode: number; // u8  @0x0B
  channelId: number; // u8  @0x0C
  signCode: number; // u8  @0x0D (1 = GCM body)
  isResponse: number; // u8  @0x0E (request vs response)
  devType: number; // u8  @0x0F
}

export interface SignalFrame {
  header: SignalHeader;
  body: Buffer;
}

/** Build a 16-byte signaling header. */
export function encodeHeader(h: Partial<SignalHeader> & { commandId: number; paramLen: number }): Buffer {
  const buf = Buffer.alloc(SIGNAL_HEADER_BYTES);
  buf.writeUInt32LE(SIGNAL_MAGIC, 0);
  buf.writeUInt16LE(h.commandId & 0xffff, 4);
  buf.writeUInt32LE(h.paramLen >>> 0, 6);
  buf.writeUInt8(h.version ?? 0, 0x0a);
  buf.writeUInt8(h.irMode ?? 0, 0x0b);
  buf.writeUInt8(h.channelId ?? 0, 0x0c);
  buf.writeUInt8(h.signCode ?? 0, 0x0d);
  buf.writeUInt8(h.isResponse ?? 0, 0x0e);
  buf.writeUInt8(h.devType ?? 0, 0x0f);
  return buf;
}

/** Build a full frame (header + body). */
export function encodeFrame(
  h: Omit<Partial<SignalHeader>, "paramLen"> & { commandId: number },
  body: Buffer = Buffer.alloc(0),
): Buffer {
  return Buffer.concat([encodeHeader({ ...h, paramLen: body.length }), body]);
}

/** Parse one header from a buffer at `offset`. Returns undefined if too short or bad magic. */
export function parseHeader(buf: Buffer, offset = 0): SignalHeader | undefined {
  if (buf.length - offset < SIGNAL_HEADER_BYTES) return undefined;
  if (buf.readUInt32LE(offset) !== SIGNAL_MAGIC) return undefined;
  return {
    commandId: buf.readUInt16LE(offset + 4),
    paramLen: buf.readUInt32LE(offset + 6),
    version: buf.readUInt8(offset + 0x0a),
    irMode: buf.readUInt8(offset + 0x0b),
    channelId: buf.readUInt8(offset + 0x0c),
    signCode: buf.readUInt8(offset + 0x0d),
    isResponse: buf.readUInt8(offset + 0x0e),
    devType: buf.readUInt8(offset + 0x0f),
  };
}

/**
 * Stream de-framer for the TCP signaling socket: pulls complete frames out of an accumulating
 * buffer. Returns the parsed frames plus the leftover bytes (a partial next frame). Drops bytes
 * up to the next `XZYH` magic if the stream desyncs.
 */
export function extractFrames(buf: Buffer): { frames: SignalFrame[]; rest: Buffer } {
  const frames: SignalFrame[] = [];
  let off = 0;
  while (off + SIGNAL_HEADER_BYTES <= buf.length) {
    if (buf.readUInt32LE(off) !== SIGNAL_MAGIC) {
      // resync: find next magic
      const next = buf.indexOf(Buffer.from([0x58, 0x5a, 0x59, 0x48]), off + 1);
      if (next < 0) return { frames, rest: Buffer.alloc(0) };
      off = next;
      continue;
    }
    const header = parseHeader(buf, off)!;
    const total = SIGNAL_HEADER_BYTES + header.paramLen;
    if (off + total > buf.length) break; // incomplete body — wait for more
    frames.push({ header, body: buf.subarray(off + SIGNAL_HEADER_BYTES, off + total) });
    off += total;
  }
  return { frames, rest: buf.subarray(off) };
}
