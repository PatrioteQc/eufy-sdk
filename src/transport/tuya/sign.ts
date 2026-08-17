/**
 * Tuya / Thingclips `api.json` request signing.
 *
 * The signature is computed in two stages:
 *
 *  1. **preimage** (pure-Java, fully reversed + encoded here): take the request param map, keep
 *     ONLY the allowlisted keys with a non-empty value, sort those keys ascending, and join them
 *     as `key=value` with `||`. The `postData` value is first replaced by an md5-then-swap
 *     transform ({@link swapMd5}) so the (potentially large) body is folded to a fixed 32 chars.
 *
 *  2. **digest** (was NATIVE — command 1 in `libthing_security.so`; now SOLVED):
 *     `sign = HMAC-SHA256(K, preimage)` as lowercase hex, where K is the recovered app-wide constant
 *     (supplied via the `TUYA_SIGN_KEY` env var — see {@link HmacSigner}; not hardcoded here). Behind
 *     the {@link TuyaSigner} seam: {@link HmacSigner} is the real implementation; {@link StubSigner}
 *     (throws) remains for wiring/tests without a key.
 */
import { createHash, createHmac } from "node:crypto";

/**
 * Keys that participate in the signature, in no particular order (the preimage builder sorts).
 * Everything else in the request (bizData, sdkVersion, os-info fields, cp/channel/nd, …) is
 * DELIBERATELY excluded from the sign. Verified against a live preimage (see the spec test).
 */
export const SIGN_ALLOWLIST: ReadonlySet<string> = new Set([
  "a",
  "v",
  "lat",
  "lon",
  "lang",
  "deviceId",
  "appVersion",
  "ttid",
  "isH5",
  "h5Token",
  "os",
  "clientId",
  "postData",
  "time",
  "requestId",
  "et",
  "n4h5",
  "sid",
  "chKey",
  "sp",
]);

/**
 * The `postData` sign transform: md5 the body to 32 hex chars, then rotate the four 8-char blocks
 * `[b0 b1 b2 b3]` → `[b1 b0 b3 b2]`. This is the Thingclips SDK 7.5.0 transform; it is applied to
 * the `postData` value before it is joined into the preimage.
 *
 * ✅ Confirmed: the `thing.m.user.uid.token.create` call carries a `postData`, and its
 * sign (computed over this transform) was accepted by `a1.tuyaeu.com` with no SIGN_INVALID — so a
 * postData-bearing preimage IS exercised end-to-end. (The static `smartlife.p.time.get` golden vector
 * separately carries no postData; the two together cover both paths.)
 */
export function swapMd5(postData: string): string {
  const h = createHash("md5").update(postData, "utf-8").digest("hex");
  return h.slice(8, 16) + h.slice(0, 8) + h.slice(24, 32) + h.slice(16, 24);
}

/**
 * Build the exact sign **preimage** from a request param map. Keeps only allowlisted keys with a
 * non-empty value, sorts them ascending, and joins `key=value` pairs with `||`. `postData` is
 * folded via {@link swapMd5} before joining.
 */
export function buildSignPreimage(params: Readonly<Record<string, string | undefined>>): string {
  const keys = Object.keys(params)
    .filter((k) => SIGN_ALLOWLIST.has(k) && params[k] !== undefined && params[k] !== "")
    .sort(); // default lexicographic sort = ASCII ascending, matching the native ordering
  return keys.map((k) => `${k}=${k === "postData" ? swapMd5(params[k] as string) : params[k]}`).join("||");
}

/**
 * The native signing seam. Given the {@link buildSignPreimage} output, return the final `sign`
 * value (SHA-256-length hex). Implementations mix in the app secret natively.
 */
export interface TuyaSigner {
  sign(preimage: string): string;
}

/**
 * Placeholder {@link TuyaSigner} that throws. Lets the request builder + client be wired and
 * unit-tested (with an injected fake signer) before the native digest is cracked; swap in the real
 * signer to make live calls work.
 */
export class StubSigner implements TuyaSigner {
  sign(_preimage: string): string {
    throw new Error(
      "native sign not yet implemented: the api.json `sign` digest is computed in " +
        "libthing_security.so (command 1) and has not been reversed — inject a real TuyaSigner",
    );
  }
}

/**
 * The native-digest key **K**: `sign = HMAC-SHA256(K, preimage)` (lowercase hex) — proven by
 * the native signer (command 1 → `mbedtls_md_hmac`, SHA-256), confirmed by
 * reproducing a live-captured signature. K is a per-app-build CONSTANT (the same for every eufy user,
 * NOT tied to any account), assembled natively as `package_cert_stego_appSecret`:
 *   - the package name (`com.oceanwing.battery.cam`),
 *   - the developer signing-cert SHA-256 (public),
 *   - the value hidden by keyed steganography in `assets/t_s.bmp` (the only genuinely-hidden part —
 *     extracted once from the running app's memory at `libthing_security.so + 0x384f0`),
 *   - the manifest app secret (== {@link TUYA_APP_SECRET}).
 *
 * It authorizes requests — treat it like the app secret, so it is NOT baked into this source. Supply
 * it out-of-band via the `TUYA_SIGN_KEY` env var (or pass it to {@link HmacSigner}).
 *
 * The real {@link TuyaSigner}: `sign = HMAC-SHA256(key, preimage)` as lowercase hex. The key is read
 * from `process.env.TUYA_SIGN_KEY` unless one is passed explicitly; the constructor throws if neither
 * is present, so a missing key fails loudly instead of producing a wrong sign. Verified: reproduces
 * the captured `smartlife.p.time.get` sign `97a78b35…a7f8c84` from its preimage.
 */
export class HmacSigner implements TuyaSigner {
  private readonly key: string;
  constructor(key?: string) {
    const k = key ?? process.env.TUYA_SIGN_KEY;
    if (!k) {
      throw new Error(
        "HmacSigner: no sign key — set the TUYA_SIGN_KEY env var (the recovered app-wide K = " +
          "package_cert_stego_appSecret) or pass one explicitly.",
      );
    }
    this.key = k;
  }
  sign(preimage: string): string {
    return createHmac("sha256", this.key).update(preimage, "utf-8").digest("hex");
  }
}

/**
 * Channel key sent on every request as `chKey`.
 * Extracted from the eufy Security/Mega APK (`com.oceanwing.battery.cam`); present in the sign
 * preimage — confirmed from the live-captured golden vector in `scripts/tuya/setup-sign-key.mjs`.
 */
export const TUYA_CHKEY = "7cbfe6d8";
