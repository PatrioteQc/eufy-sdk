/**
 * eufy WebRTC **signaling-body** cipher: AES-128-GCM.
 *
 * Reversed from `rtc_crypto_encrypt_cmd_data` (@0x1fb470) / `rtc_crypto_decrypt_notify_data_gcm`
 * (@0x1faac0) in `libmega_media_sdk.so`. When a signaling frame has `signCode === 1`
 * (`version === 0x0A`), its body is GCM-encrypted under the 16-byte `aes_key` the app feeds the SDK
 * via `rtc_signal_set_quick_login_info` (NOT a length-prefixed IV‖ct‖tag).
 *
 * **Body layout (PROVEN from the notify decryptor @0x1faac0):**
 *   `TAG(16) ‖ IV(12) ‖ CIPHERTEXT`        — `ct_len = param_len - 0x1C` (28)
 * The encryptor reserves `0x20` (32) of prefix vs the decryptor's `0x1C` (28): there are likely
 * **4 reserved/bookkeeping bytes** ahead of the tag on the *send* path. Placement is unconfirmed
 * from disasm alone, so:
 *   - `decryptSignalBody` tries `TAG‖IV‖CT` first, then `reserved(4)‖TAG‖IV‖CT` (tolerant).
 *   - `encryptSignalBody(key, pt, { reserved4: true })` prepends the 4 zero bytes when talking to
 *     the live server; default off keeps a clean round-trip. One capture disambiguates 28-vs-32.
 *
 * This is DISTINCT from the media-frame cipher (AES-256-GCM under the ECC `get_ciphers` key,
 * src/p2p/video.ts) — signaling uses AES-128-GCM under the login key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const IV_LEN = 12;
const TAG_LEN = 16;
const RESERVED_LEN = 4;

/**
 * Encrypt a signaling body. Returns `TAG(16) ‖ IV(12) ‖ CIPHERTEXT`, or
 * `reserved(4,0) ‖ TAG ‖ IV ‖ CT` when `opts.reserved4` is set. `aesKey` must be 16 bytes.
 */
export function encryptSignalBody(aesKey: Buffer, plaintext: Buffer, opts: { reserved4?: boolean } = {}): Buffer {
  if (aesKey.length !== 16) throw new Error(`aesKey must be 16 bytes, got ${aesKey.length}`);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-128-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const core = Buffer.concat([cipher.getAuthTag(), iv, ct]); // TAG ‖ IV ‖ CT
  return opts.reserved4 ? Buffer.concat([Buffer.alloc(RESERVED_LEN), core]) : core;
}

function tryDecrypt(aesKey: Buffer, body: Buffer): Buffer | undefined {
  if (body.length < TAG_LEN + IV_LEN) return undefined;
  try {
    const tag = body.subarray(0, TAG_LEN);
    const iv = body.subarray(TAG_LEN, TAG_LEN + IV_LEN);
    const ct = body.subarray(TAG_LEN + IV_LEN);
    const decipher = createDecipheriv("aes-128-gcm", aesKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return undefined;
  }
}

/**
 * Decrypt a signaling body laid out as `TAG(16) ‖ IV(12) ‖ CIPHERTEXT` (the proven notify layout),
 * falling back to a leading 4-byte reserved slot. Returns undefined on auth failure.
 */
export function decryptSignalBody(aesKey: Buffer, body: Buffer): Buffer | undefined {
  if (aesKey.length !== 16) throw new Error(`aesKey must be 16 bytes, got ${aesKey.length}`);
  return tryDecrypt(aesKey, body) ?? tryDecrypt(aesKey, body.subarray(RESERVED_LEN));
}
