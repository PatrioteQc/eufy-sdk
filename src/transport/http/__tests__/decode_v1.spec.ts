import { createCipheriv } from "node:crypto";
import { decodeImageV1, isV1Image, getImageKey, V1_PREFIX } from "../decodeImageV1.js";

/**
 * v1 `eufysecurity:` decode — synthetic round-trip (offline, no account data).
 * We can't trigger a live v1 (current cameras only emit v2), so we BUILD a v1 blob
 * by encrypting a known payload with the exact same key derivation, then assert the
 * decoder recovers the original bytes. This fully exercises the parse + key-derivation
 * + AES-128-ECB head-decrypt path.
 *
 * ⚠️ This proves the decoder is SELF-CONSISTENT, not that the (legacy ecs) key derivation matches
 * V6 — V6 derives the key in native `genCheckCode` (see the decodeImageV1 header). Round-trip only.
 */
const SERIAL = "T8010P1234567890"; // 16 chars
const CODE = "AB12345678"; // 10 chars
const P2P_DID = "ABCDEF-123456-ABCDE"; // matches getIdSuffix regex ^[A-Z]+-(\d+)-[A-Z]+$

/** Build a v1 blob whose first 256 DATA bytes are AES-128-ECB encrypted (no padding). */
function makeV1Blob(plaintextData: Buffer): Buffer {
  const key = Buffer.from(getImageKey(SERIAL, P2P_DID, CODE), "utf-8").subarray(0, 16);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const head = Buffer.concat([cipher.update(plaintextData.subarray(0, 256)), cipher.final()]);
  const tail = plaintextData.subarray(256);
  // eufysecurity:<SERIAL>:<CODE>:<DATA>
  const header = Buffer.from(`${V1_PREFIX}:${SERIAL}:${CODE}:`, "latin1");
  return Buffer.concat([header, head, tail]);
}

describe("decodeImageV1 (legacy eufysecurity)", () => {
  // a "JPEG-ish" payload: 256B head (gets encrypted) + a plaintext tail
  const original = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(252, 0x7a),
    Buffer.from("PLAINTEXT-TAIL-SCAN-DATA"),
    Buffer.from([0xff, 0xd9]),
  ]);

  it("detects a v1 blob and rejects v2 / plain", () => {
    const blob = makeV1Blob(original);
    expect(isV1Image(blob)).toBe(true);
    expect(isV1Image(Buffer.from("v2_eufysecurity:T8:1:x"))).toBe(false);
    expect(isV1Image(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
  });

  it("round-trips: decrypt recovers the original DATA bytes", () => {
    const blob = makeV1Blob(original);
    const out = decodeImageV1(blob, P2P_DID);
    expect(out).not.toBeNull();
    expect(out!.equals(original)).toBe(true);
    // framing intact
    expect(out!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(out!.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it("returns null for a non-v1 buffer", () => {
    expect(decodeImageV1(Buffer.from("v2_eufysecurity:x"), P2P_DID)).toBeNull();
  });

  it("key derivation is deterministic for the same inputs", () => {
    expect(getImageKey(SERIAL, P2P_DID, CODE)).toBe(getImageKey(SERIAL, P2P_DID, CODE));
  });
});
