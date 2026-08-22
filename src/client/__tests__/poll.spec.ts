import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";
import type { ParamChange } from "../device-registry.js";

/**
 * The cloud-param poll loop — the producer behind the capabilities' `source:"poll"` event mappings.
 *
 * Driven through the facade end-to-end, because the decode half is covered separately
 * (`capabilities/__tests__/decode-event.spec.ts` asserts param 1101 → `batteryLevel`) and both halves
 * passing in isolation says nothing about a signal actually reaching a listener. A changed param must
 * come out as a semantic event. Also pins the loop's lifecycle: self-rescheduling, surviving a failed
 * pass, and stopping on disconnect.
 */
function makeClient(opts: Record<string, unknown> = {}) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", ...opts });
  Object.defineProperty((eufy as any).mega, "auth", {
    configurable: true,
    get: () => ({ userId: "u", authToken: "t" }),
  });
  vi.spyOn(eufy as any, "startPush").mockResolvedValue(undefined);
  vi.spyOn(eufy as any, "warmWiredP2P").mockResolvedValue({ required: 0, ready: 0, failed: 0, pending: 0 });
  vi.spyOn(eufy, "getMqttDevices").mockReturnValue([]);
  vi.spyOn(eufy, "getDevices").mockResolvedValue([]);
  vi.spyOn((eufy as any).registry, "list").mockReturnValue([{ sn: "a" }]);
  return eufy;
}

const paramChange = (paramType: number, from: string, to: string): ParamChange => ({
  deviceSn: "T8000P0000000000",
  paramType,
  from,
  to,
  params: { [paramType]: to },
});

/** BATTERY_PARAM.BATTERY changing from a known level. */
const batteryChange = (to: string): ParamChange => paramChange(1101, "88", to);

describe("cloud-param poll loop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("turns a changed battery param into a batteryLevel event", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [batteryChange("81")],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("batteryLevel", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ deviceSn: "T8000P0000000000", paramType: 1101, from: "88", to: "81" });
  });

  /**
   * A poll change must be decoded against the changed device's capabilities, exactly as a push is.
   *
   * Without them `resolveHits` cannot disambiguate a param id claimed by more than one capability, so a
   * contested id resolves to nothing and a poll event declared on it is silently never emitted. The
   * resolution itself is pinned in `capabilities/__tests__/decode-event.spec.ts`; what is asserted here
   * is that the argument reaches the decode at all, which is the whole of the defect — no shipped id is
   * contested today, so nothing else about this call is observable from the outside.
   */
  it("decodes a poll change against the changed device's capabilities", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [batteryChange("81")],
      added: [],
      removed: [],
      reported: [],
    });
    const caps = vi.spyOn((eufy as any).registry, "capabilitiesForDevice").mockReturnValue(new Set(["battery"]));

    await (eufy as any).pollOnce();

    expect(caps).toHaveBeenCalledWith("T8000P0000000000");
  });

  /**
   * Camera enablement is the state #47 wanted announced: it only ever arrives as a cloud param, so
   * re-reading was the only way to learn of a change and re-reading cannot say WHEN. Both wire ids
   * carry it, under opposite polarity — 1035 is a disable bit, 2001 reports it directly — so the event
   * normalises to `enabled` rather than handing a caller the raw value and its polarity.
   */
  it("announces a camera enablement change, in the polarity the reporting id uses", async () => {
    const eufy = makeClient();
    const changes = [paramChange(1035, "0", "1"), paramChange(2001, "false", "true")];
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: changes,
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("cameraEnabled", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ deviceSn: "T8000P0000000000", paramType: 1035, enabled: false });
    expect(seen[1]).toMatchObject({ paramType: 2001, enabled: true });
  });

  /**
   * A poll pass re-resolves the devices a caller is holding, and that path only ever ADDS — so it must
   * hand the resolver the whole record. An attached camera is granted guard mode by its curated model
   * row and withheld it again for hanging off a hub; re-resolving from a record that lost the topology
   * would hand it straight back, one param change after the caller got a device that correctly lacked it.
   */
  it("a poll pass does not hand an attached camera back the hub's guard mode", async () => {
    const eufy = makeClient();
    const record = {
      model: "T8170",
      category: "eufy_security",
      deviceType: 48,
      parentSn: "T8030P0000000000",
      params: { 1224: "1" },
      paramUpdatedAt: {},
    };
    vi.spyOn((eufy as any).registry, "record").mockResolvedValue(record);
    const dev = Device.fromRecord("T8000P0000000000", record);
    expect(dev.has("arming")).toBe(false);
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(dev));
    const gained: unknown[] = [];
    eufy.on("deviceCapabilities", (e) => gained.push(e));

    await (eufy as any).widenCapabilities("T8000P0000000000");

    expect(dev.has("arming")).toBe(false);
    expect(gained).toEqual([]);
  });

  it("emits nothing when no param changed", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: unknown[] = [];
    eufy.on("event", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });

  it("re-arms after each run, so the loop keeps polling", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("survives a failing poll — reports it and keeps the loop alive", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const boom = new Error("cloud down");
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockRejectedValueOnce(boom)
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });
    const errors: unknown[] = [];
    eufy.on("error", (e) => errors.push(e));

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toContain(boom); // surfaced, not thrown

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2); // a transient failure must not kill the loop
  });

  it("pollMs:0 disables the loop entirely", async () => {
    const eufy = makeClient({ pollMs: 0 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(poll).not.toHaveBeenCalled();
  });

  it("disconnect stops the loop (no polling after teardown)", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    await eufy.disconnect();
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("auto-realtime starts the loop", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    await (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(1000);

    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe("setPollInterval (runtime poll-interval change)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("reports the configured interval, and the default when unset", () => {
    expect(makeClient({ pollMs: 1234 }).pollIntervalMs).toBe(1234);
    expect(makeClient().pollIntervalMs).toBe(600_000); // DEFAULT_POLL_MS
  });

  it("updates the effective interval", () => {
    const eufy = makeClient({ pollMs: 1000 });
    eufy.setPollInterval(5000);
    expect(eufy.pollIntervalMs).toBe(5000);
  });

  it("re-arms a running loop at the new interval immediately", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1); // old 1s cadence

    eufy.setPollInterval(5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1); // the old 1s tick no longer fires
    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(2); // fires at the new 5s cadence
  });

  it("setPollInterval(0) stops a running loop", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    eufy.setPollInterval(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(poll).toHaveBeenCalledTimes(1); // disabled — no further polls
  });
});

describe("device hot-plug events", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const dev = (sn: string) => ({ sn, realtime: "p2p" }) as never;

  it("emits deviceAdded / deviceRemoved from the poll diff", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [dev("NEW")],
      removed: [dev("GONE")],
      reported: [],
    });
    const added: string[] = [];
    const removed: string[] = [];
    eufy.on("deviceAdded", (d) => added.push(d.sn));
    eufy.on("deviceRemoved", (d) => removed.push(d.sn));

    await (eufy as any).pollOnce();

    expect(added).toEqual(["NEW"]);
    expect(removed).toEqual(["GONE"]);
  });

  it("emits nothing when the roster is unchanged", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: string[] = [];
    eufy.on("deviceAdded", (d) => seen.push(d.sn));
    eufy.on("deviceRemoved", (d) => seen.push(d.sn));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });
});

/**
 * Shutdown vs the fire-and-forget realtime bring-up.
 *
 * `login()` starts the channels without awaiting them, so a bring-up can finish long after the caller
 * moved on. A finished bring-up is installed only while it is still the current one: otherwise the
 * channels it built are closed on the spot, never installed and never left holding a socket.
 *
 * The bring-up therefore ASSEMBLES rather than installs — a stale one must not tear down the channels
 * a later login legitimately brought up, so the ownership check lives at the single install site.
 */
describe("disconnect during startup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  /** A push client stand-in whose only observable behaviour is whether it got closed. */
  const gatedPush = (eufy: EufyMega) => {
    const client = { close: vi.fn(), setPersistentIds: vi.fn(), on: vi.fn(), connect: vi.fn() };
    let release!: () => void;
    vi.spyOn(eufy as any, "startPush").mockReturnValue(new Promise((r) => (release = () => r(client))));
    return { client, release: () => release() };
  };

  it("closes the channels a slow bring-up opened after teardown had run", async () => {
    const eufy = makeClient();
    const push = gatedPush(eufy);

    const starting = (eufy as any).ensureRealtime();
    await eufy.disconnect();
    push.release();
    await starting;

    await vi.waitFor(() => expect(push.client.close).toHaveBeenCalled());
    expect((eufy as any).pushClient).toBeUndefined(); // never installed
  });

  /**
   * The case a single "closing" flag cannot express: `login()` clears it, so the stale bring-up would
   * finish, see nothing amiss, and overwrite the live channel — stranding the socket it was meant to
   * release and leaving the session with none.
   */
  it("does not clobber the channels a later login brought up", async () => {
    const eufy = makeClient();
    const stale = gatedPush(eufy);

    const starting = (eufy as any).ensureRealtime();
    await eufy.disconnect();

    const fresh = gatedPush(eufy); // the second login's bring-up wins the install
    const restarting = (eufy as any).ensureRealtime();
    fresh.release();
    await restarting;
    stale.release();
    await starting;

    expect((eufy as any).pushClient).toBe(fresh.client);
    expect(fresh.client.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stale.client.close).toHaveBeenCalled());
  });

  it("does not arm the poll loop when the bring-up finishes after a disconnect", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const push = gatedPush(eufy);
    const poll = vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });

    const starting = (eufy as any).ensureRealtime();
    await eufy.disconnect();
    push.release();
    await starting;

    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).not.toHaveBeenCalled();
  });

  it("a later login brings realtime back up", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    vi.spyOn((eufy as any).mega, "login").mockResolvedValue({
      status: "ok",
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    const poll = vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    await eufy.disconnect();

    await eufy.login();
    await vi.advanceTimersByTimeAsync(1000);

    expect(poll).toHaveBeenCalled();
  });
});

/**
 * The poll baseline must be a snapshot of VALUES, not of the records the registry hands out.
 *
 * `this.devices` holds the same objects, so anything that updates one in place rewrites the baseline before
 * the next pass can diff against it. `applyRealtimeParams` does exactly that to `lastSeenMs` — a station's
 * report stamps the record the baseline is holding — so a device that reports over realtime loses the poll's
 * liveness signal. The param half is guarded against the same mutation, which no current path performs.
 */
describe("poll baseline isolation", () => {
  beforeEach(() => vi.restoreAllMocks());

  /** A registry with one device whose params a test can mutate the way the realtime path does. */
  async function registryWithDevice() {
    const { DeviceRegistry } = await import("../device-registry.js");
    const device: any = { sn: "T8000P0000000000", params: { 2001: "false" }, lastSeenMs: 1 };
    const registry = new DeviceRegistry({ mega: {} as never, onError: () => {} });
    vi.spyOn(registry, "getDevices").mockImplementation(async () => [device]);
    return { registry, device };
  }

  it("reports a change written into the record after the baseline was taken", async () => {
    const { registry, device } = await registryWithDevice();
    await registry.pollChanges(); // baseline

    device.params = { ...device.params, 2001: "true" }; // the station volunteers the new value
    const diff = await registry.pollChanges();

    expect(diff.params).toEqual([
      { deviceSn: "T8000P0000000000", paramType: 2001, from: "false", to: "true", params: { 2001: "true" } },
    ]);
  });

  /** The half that bites today: a realtime report stamps `lastSeenMs` on the record the baseline holds. */
  it("reports a device as re-reported after its record was updated in place", async () => {
    const { registry, device } = await registryWithDevice();
    await registry.pollChanges();

    device.lastSeenMs = 2;
    const diff = await registry.pollChanges();

    expect(diff.reported.map((d) => d.sn)).toEqual(["T8000P0000000000"]);
  });

  /** An unchanged pass still reports nothing, so the isolation cannot fake a change. */
  it("stays silent when nothing moved", async () => {
    const { registry } = await registryWithDevice();
    await registry.pollChanges();

    const diff = await registry.pollChanges();

    expect(diff.params).toEqual([]);
    expect(diff.reported).toEqual([]);
  });
});
