/**
 * eufy leo_rtc signaling **transport envelope** ("NewRTCProtocol" obfuscation header).
 *
 * Every XZYH signaling frame written to the signaling socket is wrapped by
 * `ProtocolSetObfuscateHeader` (@0x204ca8 in libmega_media_sdk.so) before `RTCAppNetworkSend`
 * (@0x20241c) emits it via `sendto`/`send`. Layout reversed + validated against the symmetric
 * parser `ProtocolParseObfuscateHeader` (@0x204b58).
 *
 * Wire layout (22-byte header + XOR'd payload + random tail padding):
 *   0x00 u16  magic       = 0x0008 (LE → `08 00`)
 *   0x02 u16  total_len   = payloadLen + padLen
 *   0x04 16B  keystream   16 random bytes (the XOR key)
 *   0x14 u8   padLen
 *   0x15 u8   random
 *   0x16 ...  payload[i] XOR keystream[i & 0x0F]   (payloadLen bytes)
 *   ...       padLen random bytes
 * Datagram/chunk length = 0x16 + payloadLen + padLen; minimum valid envelope = 23 bytes.
 */
import { randomBytes, randomInt } from "crypto";

const HDR_LEN = 0x16; // 22
const MAGIC = 0x0008;
const KEY_OFF = 0x04;
const KEY_LEN = 16;
const PAD_MAX_TOTAL = 0x3d3; // native caps payloadLen + padLen under this when choosing padLen

/** Wrap an XZYH frame in the obfuscation envelope. `padLen` is overridable for deterministic tests. */
export function wrapObfuscate(frame: Buffer, padLen?: number): Buffer {
  const room = Math.max(1, PAD_MAX_TOTAL - frame.length);
  const pad = padLen != null ? padLen & 0xff : randomInt(0, Math.min(256, room));
  const key = randomBytes(KEY_LEN);
  const buf = Buffer.alloc(HDR_LEN + frame.length + pad);
  buf.writeUInt16LE(MAGIC, 0);
  buf.writeUInt16LE((frame.length + pad) & 0xffff, 2);
  key.copy(buf, KEY_OFF);
  buf[0x14] = pad;
  buf[0x15] = randomBytes(1)[0];
  for (let i = 0; i < frame.length; i++) buf[HDR_LEN + i] = frame[i] ^ key[i & 0x0f];
  if (pad) randomBytes(pad).copy(buf, HDR_LEN + frame.length);
  return buf;
}

/** Strip the obfuscation envelope, returning the inner XZYH frame, or undefined if malformed. */
export function unwrapObfuscate(buf: Buffer): Buffer | undefined {
  if (buf.length < 0x17 || buf.readUInt16LE(0) !== MAGIC) return undefined;
  const total = buf.readUInt16LE(2);
  const padLen = buf[0x14];
  const n = total - padLen; // real payload length
  if (n < 0 || HDR_LEN + n > buf.length) return undefined;
  const key = buf.subarray(KEY_OFF, KEY_OFF + KEY_LEN);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = buf[HDR_LEN + i] ^ key[i & 0x0f];
  return out;
}
