import { TuyaClient, genDeviceId } from "../client.js";
import type { TuyaSigner } from "../sign.js";
import type { TuyaHttpPost } from "../request.js";

class FixedSigner implements TuyaSigner {
  sign(): string {
    return "f".repeat(64);
  }
}

/**
 * A minimal {@link TuyaHttpPost} stand-in: records each POST and replies from a queued list of envelopes.
 */
function stubHttp(replies: unknown[]): { http: TuyaHttpPost; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  const http: TuyaHttpPost = async (url, body) => {
    calls.push({ url, body });
    return replies[i++];
  };
  return { http, calls };
}

describe("genDeviceId", () => {
  it("returns a 44-hex-char id", () => {
    const id = genDeviceId();
    expect(id).toMatch(/^[0-9a-f]{44}$/);
    expect(genDeviceId()).not.toBe(id); // random
  });
});

describe("TuyaClient", () => {
  it("seeds the session from config (deviceId + chKey, empty sid pre-login)", () => {
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", deviceId: "a".repeat(44) });
    expect(c.getSession()).toEqual({ sid: "", deviceId: "a".repeat(44), chKey: "7cbfe6d8" });
    expect(c.loggedIn).toBe(false);
  });

  it("generates a deviceId when none is supplied", () => {
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8" });
    expect(c.getSession().deviceId).toMatch(/^[0-9a-f]{44}$/);
  });

  it("buildRequest embeds session fields and a sign", () => {
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", deviceId: "b".repeat(44) });
    const params = c.buildRequest({ a: "smartlife.p.time.get", v: "1.0" });
    expect(params.chKey).toBe("7cbfe6d8");
    expect(params.deviceId).toBe("b".repeat(44));
    expect(params.sign).toBe("f".repeat(64));
  });

  it("getDeviceDps posts the cache.dp.get action", async () => {
    const { http, calls } = stubHttp([{ success: true, result: { dps: {} } }]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    const res = await c.getDeviceDps("dev-1");
    expect(res.success).toBe(true);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("a")).toBe("thing.m.device.cache.dp.get");
    expect(JSON.parse(body.get("postData")!)).toEqual({ devId: "dev-1", dpCacheType: 1 });
  });

  it("publishDps refuses to send by default (unverified write gate)", async () => {
    const { http, calls } = stubHttp([{ success: true }]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    await expect(c.publishDps("dev-1", "gw-1", { "101": true })).rejects.toThrow(/UNVERIFIED/);
    expect(calls).toHaveLength(0); // nothing was sent
  });

  it("publishDps posts the dp.publish action with nested dps when allowUnverified", async () => {
    const { http, calls } = stubHttp([{ success: true }]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    await c.publishDps("dev-1", "gw-1", { "101": true }, { allowUnverified: true });
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("a")).toBe("thing.m.device.dp.publish");
    expect(JSON.parse(body.get("postData")!)).toEqual({
      gwId: "gw-1",
      devId: "dev-1",
      dps: JSON.stringify({ "101": true }),
    });
  });

  it("login runs token.create then password.login and stores the sid", async () => {
    const { http, calls } = stubHttp([
      { success: true, result: { token: "TOK-1" } },
      { success: true, result: { sid: "eu-sid-xyz", uid: "tuya-uid-9" } },
    ]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    const res = await c.login("12345", "44");

    expect(res).toEqual({ sid: "eu-sid-xyz", uid: "tuya-uid-9" });
    expect(c.loggedIn).toBe(true);
    expect(c.getSession().sid).toBe("eu-sid-xyz");

    // step 1 = token.create with the derived username, step 2 = password.login carrying the token
    const step1 = new URLSearchParams(calls[0].body);
    expect(step1.get("a")).toBe("thing.m.user.uid.token.create");
    expect(JSON.parse(step1.get("postData")!)).toEqual({ countryCode: "44", uid: "eufyhome-12345" });

    const step2 = new URLSearchParams(calls[1].body);
    expect(step2.get("a")).toBe("thing.m.user.uid.password.login");
    const pd = JSON.parse(step2.get("postData")!);
    expect(pd.token).toBe("TOK-1");
    expect(pd.uid).toBe("eufyhome-12345");
    expect(pd.passwd).toBe("1774D45DA407A2B5D2D60C7AEDA64A74"); // derived password vector
  });

  it("login throws when token.create yields no token", async () => {
    const { http } = stubHttp([{ success: false, errorMsg: "boom" }]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    await expect(c.login("12345")).rejects.toThrow(/token.create failed: boom/);
  });
});
