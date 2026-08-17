/**
 * {@link TuyaClient} — the foundation glue that ties account derivation, request assembly, signing,
 * and transport into a small typed API: `login()`, `getDeviceDps()`, `publishDps()`.
 *
 * FOUNDATION status: request assembly, the `sign` (✅ cracked — {@link HmacSigner} reproduces a live
 * capture), and `chKey` (✅ solved per-appId constant `"7cbfe6d8"`) are all wired and transport-verified
 * against `a1.tuyaeu.com`. What is NOT proven end-to-end is the LOGIN round-trip: `token.create` returns
 * an undecrypted RSA envelope, so a real `sid` cannot be obtained yet — meaning `login()`, and the
 * `getDeviceDps()` / `publishDps()` calls that need a `sid`, are not live-confirmed (see their docs).
 */
import { randomBytes } from "node:crypto";
import { deriveTuyaAccount, type TuyaAccount } from "./account.js";
import { TUYA_CHKEY, type TuyaSigner } from "./sign.js";
import {
  buildApiParams,
  buildGetDeviceDpsAction,
  buildPasswordLoginAction,
  buildPublishDpsAction,
  buildTokenCreateAction,
  sendApiRequest,
  DEFAULT_TUYA_ENV,
  type TuyaAction,
  type TuyaEnv,
  type TuyaEnvelope,
  type TuyaSession,
  type TuyaHttpPost,
} from "./request.js";

/** Result of a successful {@link TuyaClient.login}. */
export interface TuyaLoginResult {
  sid: string;
  /** Tuya user id (`uid`) from the login response. */
  uid: string;
}

export interface TuyaClientConfig {
  /** The native sign seam. Required for any real call; use a fake in tests. */
  signer: TuyaSigner;
  /**
   * Channel key — defaults to {@link TUYA_CHKEY} (`"7cbfe6d8"`), the constant extracted from
   * the eufy Home/Clean APK. Override only for non-standard builds.
   */
  chKey?: string;
  /** Per-install device id; a random 44-hex one is generated if omitted (see {@link genDeviceId}). */
  deviceId?: string;
  /** Restore a prior session id (skip login). */
  sid?: string;
  /** Override the environment/static fields (see {@link TuyaEnv}). */
  env?: TuyaEnv;
  /** api.json endpoint override (region shard). */
  endpoint?: string;
  /** Inject a POST transport (test stub); default = native fetch. */
  http?: TuyaHttpPost;
}

/**
 * Generate a per-install `deviceId`. The capture shows a 44-hex-char id
 * (`7932c5202387dffd14f2e2d75e0fbb8efa1cf7f28be5`); the app derives it deterministically per
 * install, but the scheme is not reversed, so we mint a random 44-hex id and keep it stable for the
 * client's lifetime.
 * TODO(scheme): replace with the app's real derivation once known.
 */
export function genDeviceId(): string {
  return randomBytes(22).toString("hex"); // 22 bytes → 44 hex chars
}

export class TuyaClient {
  private readonly signer: TuyaSigner;
  private readonly env: TuyaEnv;
  private readonly endpoint?: string;
  private readonly http?: TuyaHttpPost;
  private session: TuyaSession;

  constructor(config: TuyaClientConfig) {
    this.signer = config.signer;
    this.env = config.env ?? DEFAULT_TUYA_ENV;
    this.endpoint = config.endpoint;
    this.http = config.http;
    this.session = {
      sid: config.sid ?? "",
      deviceId: config.deviceId ?? genDeviceId(),
      chKey: config.chKey ?? TUYA_CHKEY,
    };
  }

  /** The current per-install session identity (sid empty until {@link login}). */
  getSession(): Readonly<TuyaSession> {
    return this.session;
  }

  /** True once a login has populated a session id. */
  get loggedIn(): boolean {
    return this.session.sid !== "";
  }

  /**
   * Build the full signed param map for an action against the current session. Does not send.
   * Useful for inspection/tooling; requires a working signer (the sign step).
   */
  buildRequest(action: TuyaAction): Record<string, string> {
    return buildApiParams(action, { session: this.session, signer: this.signer, env: this.env });
  }

  /** Build + POST an action, returning the parsed envelope. Requires a working signer. */
  async call<T = unknown>(action: TuyaAction): Promise<TuyaEnvelope<T>> {
    return sendApiRequest<T>(this.buildRequest(action), { endpoint: this.endpoint, http: this.http });
  }

  /**
   * Log into the Tuya cloud from a eufy user id: derive the Tuya account
   * ({@link deriveTuyaAccount}), create a pre-login token, then password-login (auto-registers on
   * first login). On success the session id is stored and returned with the Tuya uid.
   *
   * ⚠️ STUB — currently always throws. `token.create` succeeds at the transport/sign level, but its
   * `result` is an **RSA-encrypted envelope**, not a plaintext `{ token }`, so no usable pre-login
   * token can be extracted yet (the envelope decrypt is not implemented). Until that lands `login()`
   * cannot complete; a `sid`-bearing call must use an injected `sid` (see {@link TuyaClientConfig.sid}).
   * TODO(verify): the response field names (`token`/`sid`/`uid`) and any passwd⊕token transform were
   * not pinned from the capture — see the action builders in `request.ts`.
   */
  async login(eufyUserId: string, phoneCode?: string): Promise<TuyaLoginResult> {
    const account: TuyaAccount = deriveTuyaAccount(eufyUserId, phoneCode);

    const tokenRes = await this.call<{ token?: string }>(buildTokenCreateAction(account.countryCode, account.username));
    const token = tokenRes.result?.token;
    if (!token) {
      if (tokenRes.errorMsg ?? tokenRes.errorCode) {
        throw new Error(`tuya token.create failed: ${tokenRes.errorMsg ?? tokenRes.errorCode}`);
      }
      throw new Error(
        "tuya login is a STUB: token.create returned an RSA-encrypted envelope (no plaintext `token`) — " +
          "decrypting it is not implemented, so login cannot complete. Inject a `sid` instead.",
      );
    }

    const loginRes = await this.call<{ sid?: string; uid?: string }>(
      buildPasswordLoginAction(account.countryCode, account.username, account.password, token),
    );
    const sid = loginRes.result?.sid;
    const uid = loginRes.result?.uid;
    if (!sid || !uid) {
      throw new Error(
        `tuya password.login failed: ${loginRes.errorMsg ?? loginRes.errorCode ?? "no sid/uid in result"}`,
      );
    }

    this.session = { ...this.session, sid };
    return { sid, uid };
  }

  /**
   * READ/dump a device's cached data-points (`thing.m.device.cache.dp.get`).
   * Builds the request without needing a working signer; the signer is only exercised on send.
   */
  async getDeviceDps<T = unknown>(devId: string, dpCacheType?: number): Promise<TuyaEnvelope<T>> {
    return this.call<T>(buildGetDeviceDpsAction(devId, dpCacheType));
  }

  /**
   * CONTROL: publish data-points to a device (`thing.m.device.dp.publish`). `dps` is
   * `{ "<dpId>": <value> }`. `gwId` is the gateway/parent id (equals `devId` for a standalone gw).
   *
   * ⚠️ UNVERIFIED write — refuses to send by default. The `dp.publish` param shape
   * ({@link buildPublishDpsAction}) is derived, NOT pinned against a confirmed exchange,
   * and the login round-trip that yields a real `sid` is unproven too. A wrong shape comes back as a
   * generic Tuya error indistinguishable from a real device rejection, so blindly sending would hide
   * that ambiguity. Pass `{ allowUnverified: true }` to opt in once you accept it; drop the gate when
   * the write is captured + confirmed against a device.
   */
  async publishDps<T = unknown>(
    devId: string,
    gwId: string,
    dps: Record<string, unknown>,
    opts: { allowUnverified?: boolean } = {},
  ): Promise<TuyaEnvelope<T>> {
    if (!opts.allowUnverified) {
      throw new Error(
        "tuya publishDps is UNVERIFIED: the dp.publish request shape is reversed-not-captured and the " +
          "login→sid round-trip is unproven, so a Tuya error cannot be told apart from a real device " +
          "rejection. Pass { allowUnverified: true } to send anyway.",
      );
    }
    return this.call<T>(buildPublishDpsAction(devId, gwId, dps));
  }
}
