/**
 * Tuya / Thingclips cloud-protocol client (FOUNDATION).
 *
 * A clean, typed base for the eufy app's Tuya backbone: deterministic eufy→Tuya account derivation,
 * exact `api.json` request assembly, the sign, and a small {@link TuyaClient}. Both native seams are
 * SOLVED and transport-confirmed against `a1.tuyaeu.com`:
 *   - the final `sign` = `HMAC-SHA256(K, preimage)` ({@link HmacSigner}; K is supplied via the
 *     `TUYA_SIGN_KEY` env var — see `sign.ts`). Reproduces a captured signature exactly.
 *   - the per-install `chKey` is a per-appId CONSTANT (`"7cbfe6d8"` for this build).
 *
 * This module is re-exported NAMESPACED from the package root (`export * as tuya`), so:
 *
 *   import { tuya } from "@mega-yfue/eufy-sdk";
 *   // login() is a stub (token.create returns an RSA envelope we don't decrypt) — inject a sid:
 *   const client = new tuya.TuyaClient({ signer: new tuya.HmacSigner(), chKey: "7cbfe6d8", sid });
 *   await client.getDeviceDps(devId);
 *
 * STATUS: transport + signing are live-verified (token.create returns a valid encrypted result, no
 * SIGN_INVALID). NOT done: token.create returns an RSA envelope we don't decrypt, so `login()` can't
 * mint a `sid` and control writes (`publishDps`) stay gated behind `allowUnverified`. Remaining work:
 * decrypt the token envelope → finish password.login → drive dp.get / dp.publish with the real sid.
 */
export * from "./account.js";
export * from "./sign.js";
export * from "./request.js";
export * from "./client.js";
