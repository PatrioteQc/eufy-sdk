import { snapshotWithFallback, cachedSnapshot, makeSnapshotCacheState, type SnapshotSteps } from "../media.js";
import { SnapshotUnavailableError } from "../../../core/contracts.js";
import type { P2PSession } from "../p2p-session.js";

const resolved = { session: {} as P2PSession, accountId: "acct" };
const stored = { file: "/system/snd/crop.jpg", jpeg: Buffer.from([1, 2, 3]) };
const live = { jpeg: Buffer.from([9, 9]) };

/** Build injectable steps; each may be overridden to fail. */
function steps(over: Partial<SnapshotSteps> = {}): SnapshotSteps {
  return {
    connect: () => Promise.resolve(resolved),
    stored: () => Promise.resolve(stored),
    live: () => Promise.resolve(live),
    ...over,
  };
}

describe("snapshotWithFallback", () => {
  it("returns the stored still (with its file path) when one exists — no live fallback", async () => {
    const live = vi.fn(() => Promise.resolve({ jpeg: Buffer.alloc(0) }));
    const out = await snapshotWithFallback("T8000P0000000000", steps({ live }));
    expect(out).toEqual(stored);
    expect(live).not.toHaveBeenCalled();
  });

  it("falls back to a live burst when there is no stored still — file is '' (live-derived)", async () => {
    const out = await snapshotWithFallback(
      "T8000P0000000000",
      steps({ stored: () => Promise.reject(new Error("no stored snapshot (event_count=0)")) }),
    );
    expect(out).toEqual({ file: "", jpeg: live.jpeg });
  });

  it("throws reason 'offline' when the session won't resolve (never tries stored/live)", async () => {
    const stored = vi.fn();
    const live = vi.fn();
    const err = await snapshotWithFallback(
      "T8000P0000000000",
      steps({
        connect: () => Promise.reject(new Error("connect timeout")),
        stored,
        live,
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotUnavailableError);
    expect(err.reason).toBe("offline");
    expect(stored).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
  });

  it("throws reason 'no-still' when reachable but neither stored nor live yields a frame", async () => {
    const err = await snapshotWithFallback(
      "T8000P0000000000",
      steps({
        stored: () => Promise.reject(new Error("no stored")),
        live: () => Promise.reject(new Error("no keyframe")),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotUnavailableError);
    expect(err.reason).toBe("no-still");
    expect(err.cause).toBeInstanceOf(Error); // preserves the underlying live failure
  });
});

describe("cachedSnapshot (TTL + coalescing)", () => {
  const still = (n: number) => ({ file: `f${n}`, jpeg: Buffer.from([n]) });

  it("serves the cached still within the TTL — one fetch across repeated polls", async () => {
    const state = makeSnapshotCacheState();
    let calls = 0;
    let clock = 1000;
    const fetch = () => Promise.resolve(still(++calls));
    const first = await cachedSnapshot(state, "sn", 6000, fetch, () => clock);
    clock = 5000; // still inside the 6s window
    const second = await cachedSnapshot(state, "sn", 6000, fetch, () => clock);
    expect(second).toBe(first);
    expect(calls).toBe(1); // wire hit once
  });

  it("refetches once the TTL has elapsed", async () => {
    const state = makeSnapshotCacheState();
    let calls = 0;
    let clock = 1000;
    const fetch = () => Promise.resolve(still(++calls));
    await cachedSnapshot(state, "sn", 6000, fetch, () => clock);
    clock = 8000; // past the 6s window
    await cachedSnapshot(state, "sn", 6000, fetch, () => clock);
    expect(calls).toBe(2);
  });

  it("coalesces concurrent polls into one in-flight fetch (even with ttl=0)", async () => {
    const state = makeSnapshotCacheState();
    let calls = 0;
    let release!: (v: { file: string; jpeg: Buffer }) => void;
    const fetch = () => {
      calls++;
      return new Promise<{ file: string; jpeg: Buffer }>((r) => (release = r));
    };
    const a = cachedSnapshot(state, "sn", 0, fetch);
    const b = cachedSnapshot(state, "sn", 0, fetch);
    release(still(1));
    expect(await a).toBe(await b);
    expect(calls).toBe(1); // one pull for two simultaneous callers
  });

  it("does NOT cache a failure — the next call retries", async () => {
    const state = makeSnapshotCacheState();
    let calls = 0;
    const fetch = () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(still(calls));
    };
    await expect(cachedSnapshot(state, "sn", 6000, fetch)).rejects.toThrow("offline");
    await expect(cachedSnapshot(state, "sn", 6000, fetch)).resolves.toEqual(still(2));
    expect(calls).toBe(2);
  });

  it("emits [snapshot] debug traces for fetch then cache hit", async () => {
    const state = makeSnapshotCacheState();
    const debug = vi.fn();
    const logger = { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let clock = 1000;
    const fetch = () => Promise.resolve(still(1));
    await cachedSnapshot(state, "sn", 6000, fetch, () => clock, logger);
    clock = 2000;
    await cachedSnapshot(state, "sn", 6000, fetch, () => clock, logger);
    const lines = debug.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes("fetching"))).toBe(true);
    expect(lines.some((l) => l.includes("cache hit"))).toBe(true);
  });
});
