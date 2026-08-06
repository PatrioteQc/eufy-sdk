/**
 * eufy P2P video-frame decoder (`CMD_VIDEO_FRAME`, command id 1300).
 *
 * Station→phone H.264 frames ride the `d101` media channel. Each frame's body is AES-256-GCM
 * encrypted (AAD "eufy security") under a **per-stream media key**. Keyframes carry a 129-byte
 * ECIES envelope that wraps the 32-byte media key with the camera's ECC private key (the
 * `ecc_private_key` from `get_ciphers`, or the E2E vault key for vault-enabled cameras); P/B-frames
 * omit the envelope and reuse the media key recovered from the most recent keyframe.
 *
 * Frame layout (the payload AFTER the 16-byte "XZYH" data-frame header):
 * ```
 * [0x00:0x16] 22B header  : u32@0=ciphertext len (LE); flag@0x04 bit0 = keyframe/has-ECIES-key;
 *                           res s16@0x0a=width, s16@0x0c=height; ts@0x0e
 * [0x16:0x97] 129B ECIES envelope (KEYFRAMES ONLY): ephPub(33, compressed P-256) ‖ iv(16) ‖ ct(48) ‖ HMAC(32)
 * [0x97:0xa7] 16B  GCM tag
 * [0xa7:0xb3] 12B  GCM IV/nonce
 * [0xb3:end]  H.264 ciphertext (AES-256-GCM)
 * ```
 *
 * Format + crypto reversed byte-exact from `libmega_media_sdk.so` and verified against a live
 * capture. The frame layout is the block comment above.
 */
import { createDecipheriv } from "node:crypto";
import { eciesUnwrap } from "./codec.js";

/** AAD used for the AES-256-GCM body cipher of every video frame. */
const VIDEO_GCM_AAD = Buffer.from("eufy security");

/** Fixed byte offsets within the frame payload (after the 16-byte XZYH header). */
const HEADER_LEN = 0x16; // 22-byte frame header
const ENVELOPE_OFFSET = 0x16; // ECIES envelope (keyframes only)
const ENVELOPE_LEN = 0x81; // 129 bytes
const GCM_TAG_OFFSET = 0x97; // 16-byte GCM tag
const GCM_TAG_LEN = 16;
const GCM_NONCE_OFFSET = 0xa7; // 12-byte GCM nonce
const GCM_NONCE_LEN = 12;
const BODY_OFFSET = 0xb3; // H.264 ciphertext

/** Parsed fields of a `CMD_VIDEO_FRAME` 22-byte header. */
export interface VideoFrameHeader {
  /** Length of the AES-256-GCM ciphertext body, from u32 LE @ 0x00. */
  ciphertextLength: number;
  /** True when flag@0x04 bit0 is set: a keyframe carrying the ECIES envelope. */
  keyframe: boolean;
  /** Raw flag byte at 0x04. */
  flags: number;
  /** Frame width (s16 LE @ 0x0a). */
  width: number;
  /** Frame height (s16 LE @ 0x0c). */
  height: number;
  /** Timestamp word (u32 LE @ 0x0e). */
  timestamp: number;
}

/** A successfully decoded video frame. */
export interface DecodedVideoFrame {
  /** True if this was a keyframe (IDR) — its envelope re-keyed the decoder. */
  keyframe: boolean;
  /** Decrypted H.264 elementary-stream bytes. */
  h264: Buffer;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
}

/**
 * Parse the 22-byte `CMD_VIDEO_FRAME` header. Does not validate lengths beyond the header itself,
 * so it is safe to call on a (sufficiently long) buffer to inspect frame metadata without keys.
 */
export function parseVideoFrameHeader(payload: Buffer): VideoFrameHeader | undefined {
  if (payload.length < HEADER_LEN) return undefined;
  const flags = payload.readUInt8(0x04);
  return {
    ciphertextLength: payload.readUInt32LE(0x00),
    keyframe: (flags & 0x01) === 1,
    flags,
    width: payload.readInt16LE(0x0a),
    height: payload.readInt16LE(0x0c),
    timestamp: payload.readUInt32LE(0x0e),
  };
}

/**
 * Decodes a single P2P video stream into H.264. Construct one per stream with the camera's 32-byte
 * ECC private key; feed it `CMD_VIDEO_FRAME` payloads in order. Keyframes re-key the decoder via
 * their ECIES envelope; P/B-frames reuse the cached media key. All failure modes (short/garbage
 * frame, wrong key, tampered HMAC, GCM auth failure) return `undefined` — the decoder never throws.
 */
export class VideoFrameDecoder {
  private readonly eccPrivateKeyHex: string;
  private mediaKey?: Buffer;

  /** @param eccPrivateKey the camera's 32-byte ECC private key (P-256 scalar). */
  constructor(eccPrivateKey: Buffer) {
    if (eccPrivateKey.length !== 32) throw new Error("eccPrivateKey must be 32 bytes");
    this.eccPrivateKeyHex = eccPrivateKey.toString("hex");
  }

  /** The media key recovered from the most recent keyframe, if any (for inspection/testing). */
  get currentMediaKey(): Buffer | undefined {
    return this.mediaKey ? Buffer.from(this.mediaKey) : undefined;
  }

  /**
   * Recover the per-stream media key from a keyframe's 129-byte ECIES envelope: ECIES unwrap
   * (ECDH → eufyKDF → AES-128-CBC, with the trailing HMAC verified) → 32-byte AES-256-GCM key.
   */
  private unwrapMediaKey(envelope: Buffer): Buffer | undefined {
    const key = eciesUnwrap(envelope, this.eccPrivateKeyHex, { verifyHmac: true, pkcs7: true });
    return key && key.length === 32 ? key : undefined;
  }

  /**
   * Decode one video frame. Returns the keyframe flag and decrypted H.264 bytes, or `undefined`
   * if the frame is malformed, the envelope/key is wrong, or GCM authentication fails.
   */
  decodeFrame(payload: Buffer): DecodedVideoFrame | undefined {
    const header = parseVideoFrameHeader(payload);
    if (!header) return undefined;

    if (header.keyframe) {
      if (payload.length < ENVELOPE_OFFSET + ENVELOPE_LEN) return undefined;
      const envelope = payload.subarray(ENVELOPE_OFFSET, ENVELOPE_OFFSET + ENVELOPE_LEN);
      const key = this.unwrapMediaKey(envelope);
      if (!key) return undefined; // wrong key / tampered HMAC — fail closed, keep any prior key
      this.mediaKey = key;
    }

    const mediaKey = this.mediaKey;
    if (!mediaKey) return undefined; // P/B-frame before any keyframe — no key yet

    if (payload.length < BODY_OFFSET) return undefined;
    const tag = payload.subarray(GCM_TAG_OFFSET, GCM_TAG_OFFSET + GCM_TAG_LEN);
    const nonce = payload.subarray(GCM_NONCE_OFFSET, GCM_NONCE_OFFSET + GCM_NONCE_LEN);
    const body = payload.subarray(BODY_OFFSET);

    try {
      const dec = createDecipheriv("aes-256-gcm", mediaKey, nonce);
      dec.setAAD(VIDEO_GCM_AAD);
      dec.setAuthTag(tag);
      const h264: Buffer = Buffer.concat([dec.update(body), dec.final()]);
      return { keyframe: header.keyframe, h264, width: header.width, height: header.height };
    } catch {
      return undefined;
    }
  }
}
