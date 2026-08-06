/**
 * Tuya / Thingclips account derivation for a eufy login.
 *
 * The eufy app does NOT exchange a server credential with Tuya. Instead it deterministically
 * derives a Tuya username + password from the eufy account's numeric user id and logs into the
 * Tuya cloud with them (auto-registering that Tuya user on first login). Reverse-engineered +
 * verified against a live capture of the Thingclips SDK 7.5.0:
 *
 *   username = "eufyhome-" + eufyUserId
 *   password = UPPERCASE-HEX( AES-128-CBC-NoPadding( pad16("eufyhome-"+eufyUserId, '0'), KEY, IV ) )
 *
 * where the plaintext is **leading**-zero-padded ('0', 0x30) up to the next multiple of 16 bytes
 * (V6 APK `TuyaAccountUtils.c()` builds the StringBuilder in `padStart` order — zeros first, string
 * after — matching eufy-clean `TuyaCloud.loginEx()` which calls `padStart`), and KEY / IV are the
 * fixed vectors below.
 */
import { createCipheriv } from "node:crypto";

/** Username/plaintext prefix the app prepends to the eufy user id. */
export const TUYA_USERNAME_PREFIX = "eufyhome-";

/** AES-128-CBC key used to derive the Tuya password (16 bytes). */
export const TUYA_PASSWORD_KEY = Buffer.from([
  0x24, 0x4e, 0x6d, 0x8a, 0x56, 0xac, 0x87, 0x91, 0x24, 0x43, 0x2d, 0x8b, 0x6c, 0xbc, 0xa2, 0xc4,
]);

/** AES-128-CBC IV used to derive the Tuya password (16 bytes). */
export const TUYA_PASSWORD_IV = Buffer.from([
  0x77, 0x24, 0x56, 0xf2, 0xa7, 0x66, 0x4c, 0xf3, 0x39, 0x2c, 0x35, 0x97, 0xe9, 0x3e, 0x57, 0x47,
]);

/** The Tuya username for a eufy user id (`"eufyhome-" + eufyUserId`). */
export function tuyaUsername(eufyUserId: string): string {
  return TUYA_USERNAME_PREFIX + eufyUserId;
}

/**
 * Pad a UTF-8 string with LEADING '0' (0x30) characters up to the next multiple of 16 bytes.
 * A string whose length is already a multiple of 16 is returned unchanged (NO extra full block —
 * this is character padding to satisfy the no-padding cipher, not PKCS#7).
 * Leading-zero order confirmed from V6 APK `TuyaAccountUtils.c()` and eufy-clean `padStart`.
 */
function zeroPadTo16(s: string): Buffer {
  const buf = Buffer.from(s, "utf-8");
  const rem = buf.length % 16;
  if (rem === 0) return buf;
  return Buffer.concat([Buffer.from("0".repeat(16 - rem), "utf-8"), buf]);
}

/**
 * Derive the Tuya password for a eufy user id:
 * `UPPERCASE-HEX( AES-128-CBC-NoPadding( pad16("eufyhome-"+eufyUserId), KEY, IV ) )`.
 * Deterministic (fixed KEY/IV) — the same user id always yields the same password.
 */
export function deriveTuyaPassword(eufyUserId: string): string {
  const cipher = createCipheriv("aes-128-cbc", TUYA_PASSWORD_KEY, TUYA_PASSWORD_IV);
  cipher.setAutoPadding(false); // input is pre-padded to a 16-byte multiple with '0' chars
  const ct = Buffer.concat([cipher.update(zeroPadTo16(tuyaUsername(eufyUserId))), cipher.final()]);
  return ct.toString("hex").toUpperCase();
}

/**
 * Resolve the Tuya `countryCode` login field. The eufy account's phone country code wins when set;
 * otherwise fall back by eufy server region — EU→"44", CN→"86", everything else→"1".
 * ({@link deriveTuyaAccount} passes only `phoneCode`; callers that know the region can use this
 * directly to get the region fallback.)
 */
export function resolveCountryCode(phoneCode?: string, region?: string): string {
  if (phoneCode && phoneCode.trim() !== "") return phoneCode.trim();
  switch ((region ?? "").toUpperCase()) {
    case "EU":
      return "44";
    case "CN":
      return "86";
    default:
      return "1";
  }
}

/** A derived Tuya login identity — everything needed to call the uid token/password login actions. */
export interface TuyaAccount {
  /** `"eufyhome-" + eufyUserId`. */
  username: string;
  /** AES-derived password (uppercase hex). See {@link deriveTuyaPassword}. */
  password: string;
  /** Tuya `countryCode` field. See {@link resolveCountryCode}. */
  countryCode: string;
}

/**
 * Derive the full {@link TuyaAccount} (username + password + countryCode) for a eufy user id.
 * `phoneCode` is the eufy account's phone country code; when omitted the countryCode defaults to
 * "1" (see {@link resolveCountryCode} for the region-based fallback).
 */
export function deriveTuyaAccount(eufyUserId: string, phoneCode?: string): TuyaAccount {
  return {
    username: tuyaUsername(eufyUserId),
    password: deriveTuyaPassword(eufyUserId),
    countryCode: resolveCountryCode(phoneCode),
  };
}
