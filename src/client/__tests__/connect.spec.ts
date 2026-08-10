import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { LoginStatus } from "../../transport/http/mega-client.js";
import type { EufyDevice } from "../../core/types.js";

/**
 * Connectivity is SDK-managed: a successful login auto-starts realtime via the private
 * `ensureRealtime()`. These specs assert it starts the always-on channels (push always, MQTT only when
 * appliances are present, wired P2P warm-up) once and reports per-channel failures via `error` — no
 * live sockets: every underlying start method is spied and auth is faked.
 */
function makeClient(subsets: { mqtt: number; category?: string }, opts: Record<string, unknown> = {}) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", ...opts });

  // Satisfy the `if (!this.mega.auth) throw` guard without a real login.
  Object.defineProperty((eufy as any).mega, "auth", {
    configurable: true,
    get: () => ({ userId: "u", authToken: "t" }),
  });

  const dev = (sn: string): EufyDevice => ({ sn, category: subsets.category ?? "eufy_mega" }) as unknown as EufyDevice;
  vi.spyOn((eufy as any).registry, "list").mockReturnValue([dev("a")]);
  vi.spyOn(eufy, "getMqttDevices").mockReturnValue(Array.from({ length: subsets.mqtt }, (_, i) => dev(`m${i}`)));

  // startMqtt returns a connected transport (non-optional); ensureMqttStarted installs + subscribes it.
  const fakeTransport = { subscribeDevice: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
  const mqtt = vi.spyOn(eufy as any, "startMqtt").mockResolvedValue(fakeTransport);
  const push = vi.spyOn(eufy as any, "startPush").mockResolvedValue(undefined);
  const wired = vi.spyOn(eufy as any, "warmWiredP2P").mockResolvedValue(undefined);
  const getDevices = vi.spyOn(eufy, "getDevices").mockResolvedValue([]);

  return { eufy, mqtt, push, wired, getDevices };
}

describe("EufyMega auto-realtime", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("always starts push + warms wired P2P; skips MQTT with no appliances", async () => {
    const c = makeClient({ mqtt: 0 });
    await (c.eufy as any).ensureRealtime();
    expect(c.push).toHaveBeenCalledOnce();
    expect(c.wired).toHaveBeenCalledOnce();
    expect(c.mqtt).not.toHaveBeenCalled();
  });

  it("starts MQTT when the account has appliances", async () => {
    const c = makeClient({ mqtt: 2 });
    await (c.eufy as any).ensureRealtime();
    expect(c.mqtt).toHaveBeenCalledOnce();
    expect(c.push).toHaveBeenCalledOnce();
  });

  it("is idempotent — a second call starts nothing again", async () => {
    const c = makeClient({ mqtt: 1 });
    await (c.eufy as any).ensureRealtime();
    await (c.eufy as any).ensureRealtime();
    expect(c.push).toHaveBeenCalledOnce();
    expect(c.mqtt).toHaveBeenCalledOnce();
  });

  it("loads devices first when the registry is empty", async () => {
    const c = makeClient({ mqtt: 0 });
    (c.eufy as any).registry.list.mockReturnValue([]); // force the empty branch
    await (c.eufy as any).ensureRealtime();
    expect(c.getDevices).toHaveBeenCalledOnce();
  });

  it("one channel failing is reported via error, the rest still run", async () => {
    const c = makeClient({ mqtt: 1 });
    const boom = new Error("push down");
    c.push.mockRejectedValue(boom);
    const errors: unknown[] = [];
    c.eufy.on("error", (e) => errors.push(e));

    await (c.eufy as any).ensureRealtime();

    expect(c.mqtt).toHaveBeenCalledOnce(); // sibling still ran
    expect(errors).toContain(boom); // failure surfaced, not thrown
  });

  it("a successful login triggers auto-realtime", async () => {
    const c = makeClient({ mqtt: 0 });
    const ensure = vi.spyOn(c.eufy as any, "ensureRealtime").mockResolvedValue(undefined);
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    await c.eufy.login();
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("autoRealtime:false → login does not auto-start", async () => {
    const c = makeClient({ mqtt: 0 }, { autoRealtime: false });
    const ensure = vi.spyOn(c.eufy as any, "ensureRealtime").mockResolvedValue(undefined);
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    await c.eufy.login();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("opens one transport per credential scope, and only for scopes that have devices", async () => {
    const c = makeClient({ mqtt: 0 });
    const life = { sn: "L1", category: "eufy_life" } as unknown as EufyDevice;
    const mega = { sn: "M1", category: "eufy_mega" } as unknown as EufyDevice;
    (c.eufy as any).getMqttDevices.mockReturnValue([life, mega]);

    await (c.eufy as any).ensureRealtime();

    expect(c.mqtt.mock.calls.map((a) => a[0]).sort()).toEqual(["default", "eufy_life"]);
  });

  it("does not open a second transport when every MQTT device is on one scope", async () => {
    const c = makeClient({ mqtt: 2, category: "eufy_life" });
    await (c.eufy as any).ensureRealtime();
    expect(c.mqtt.mock.calls.map((a) => a[0])).toEqual(["eufy_life"]);
  });

  it("a publish issued while its own scope is coming up does not deadlock", async () => {
    // Bringing a scope up subscribes its devices and sends their realtime-init commands, which publish
    // back on that same scope. If publishSecure awaited the bring-up memo it would wait on the bring-up
    // that is waiting on it — a hang, not a failure, so this is guarded explicitly.
    const c = makeClient({ mqtt: 1, category: "eufy_life" });
    const published: string[] = [];
    const transport = {
      subscribeDevice: vi.fn(async () => {
        await (c.eufy as any).mqtt.deps.publishSecure({ category: "eufy_life" }, "cmd/x/req", "{}");
      }),
      publish: vi.fn(async (t: string) => void published.push(t)),
      disconnect: vi.fn(async () => {}),
    };
    c.mqtt.mockResolvedValue(transport);

    await expect(
      Promise.race([
        (c.eufy as any).ensureRealtime(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("deadlocked")), 2000)),
      ]),
    ).resolves.toBeUndefined();
    expect(published).toEqual(["cmd/x/req"]);
    expect(c.mqtt).toHaveBeenCalledOnce(); // reused the in-flight transport, didn't open a second
  });

  it("a disconnect racing the bring-up leaves no MQTT transport behind", async () => {
    // The disconnect has to land while ensureRealtime is suspended BEFORE it starts any scope: the
    // per-scope guard then captures the already-bumped epoch, so it happily installs its transport, and
    // only ensureRealtime's own stale-epoch check is left to release it. Without that release a resolved
    // disconnect() leaves a live, subscribed client that nothing owns.
    const c = makeClient({ mqtt: 1, category: "eufy_life" });
    (c.eufy as any).registry.list.mockReturnValue([]); // force ensureRealtime through its getDevices await
    const transport = {
      subscribeDevice: vi.fn(async () => {}),
      publish: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    };
    c.mqtt.mockResolvedValue(transport);
    c.getDevices.mockImplementation(async () => {
      (c.eufy as any).registry.list.mockReturnValue([{ sn: "m0", category: "eufy_life" }]);
      await (c.eufy as any).disconnect();
      return [];
    });

    await (c.eufy as any).ensureRealtime();

    expect((c.eufy as any).transports.size).toBe(0);
    expect((c.eufy as any).mqttReady.size).toBe(0);
    expect(transport.disconnect).toHaveBeenCalled();
  });

  it("a captcha/2FA login result does NOT auto-start realtime", async () => {
    const c = makeClient({ mqtt: 0 });
    const ensure = vi.spyOn(c.eufy as any, "ensureRealtime").mockResolvedValue(undefined);
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({ status: LoginStatus.Captcha, image: "x" });
    await c.eufy.login();
    expect(ensure).not.toHaveBeenCalled();
  });
});
