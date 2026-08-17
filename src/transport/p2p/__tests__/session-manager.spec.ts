import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager, type PowerTier } from "../session-manager.js";
import type { P2PSession } from "../p2p-session.js";

/**
 * A minimal fake {@link P2PSession} — the manager only ever calls `close()`. `id` disambiguates
 * instances when a test asserts that a re-open produced a fresh session.
 */
function fakeSession(id = "s"): P2PSession {
  return { id, close: vi.fn().mockResolvedValue(undefined) } as unknown as P2PSession;
}

/** Build a manager whose `poweredFor` returns the given tier for every station. */
function managerFor(tier: PowerTier, extra: Record<string, unknown> = {}) {
  return new SessionManager({ poweredFor: () => tier, batteryIdleMs: 1000, commandKeepAliveMs: 100, ...extra });
}

describe("SessionManager lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("acquire opens once and coalesces concurrent cold opens", async () => {
    const mgr = managerFor("battery");
    const factory = vi.fn(async () => fakeSession());
    const [a, b] = await Promise.all([mgr.acquire("ST", factory), mgr.acquire("ST", factory)]);
    expect(factory).toHaveBeenCalledOnce();
    expect(a).toBe(b);
    expect(mgr.get("ST")).toBe(a);
  });

  it("a battery station idle-closes after the window once its last user releases", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
    mgr.addUser("ST");
    mgr.releaseUser("ST");
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).toHaveBeenCalledOnce();
    expect(mgr.has("ST")).toBe(false);
  });

  it("a wired station never idle-closes (persistent)", async () => {
    const mgr = managerFor("wired");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
    mgr.addUser("ST");
    mgr.releaseUser("ST");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(session.close).not.toHaveBeenCalled();
    expect(mgr.has("ST")).toBe(true);
  });

  it("a new user cancels a pending idle-close", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
    mgr.addUser("ST");
    mgr.releaseUser("ST");
    await vi.advanceTimersByTimeAsync(500);
    mgr.addUser("ST");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).not.toHaveBeenCalled();
  });

  it("bumpCommand keeps the session warm for the keepalive window then arms idle", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
    mgr.bumpCommand("ST");
    await vi.advanceTimersByTimeAsync(50);
    mgr.bumpCommand("ST");
    await vi.advanceTimersByTimeAsync(100);
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("remove drops a station entry and clears its idle timer", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
    mgr.addUser("ST");
    mgr.releaseUser("ST");
    mgr.remove("ST");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).not.toHaveBeenCalled();
    expect(mgr.has("ST")).toBe(false);
  });

  it("close immediately detaches a live session, cancels idle, and permits a fresh acquisition", async () => {
    const mgr = managerFor("battery");
    const first = fakeSession("first");
    const second = fakeSession("second");
    await mgr.acquire("ST", async () => first);
    mgr.addUser("ST");
    mgr.releaseUser("ST");

    await mgr.close("ST");
    await vi.advanceTimersByTimeAsync(1000);
    const reopened = await mgr.acquire("ST", async () => second);

    expect(first.close).toHaveBeenCalledOnce();
    expect(reopened).toBe(second);
  });

  it("close supersedes an in-flight acquisition and the next acquisition opens fresh", async () => {
    const mgr = managerFor("battery");
    const stale = fakeSession("stale");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const opening = mgr.acquire("ST", async (register) => {
      await gate;
      register(stale);
      return stale;
    });
    await vi.advanceTimersByTimeAsync(0);

    await mgr.close("ST");
    finish();

    await expect(opening).rejects.toThrow(/superseded/);
    expect(stale.close).toHaveBeenCalledOnce();
    const fresh = fakeSession("fresh");
    await expect(mgr.acquire("ST", async () => fresh)).resolves.toBe(fresh);
  });

  it("reset ignores command holds but waits for active session consumers", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
    mgr.addUser("ST");
    mgr.bumpCommand("ST");

    const reset = mgr.resetWhenUnused("ST");
    let resetFinished = false;
    void reset.then(() => {
      resetFinished = true;
    });
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(session.close).not.toHaveBeenCalled();
    expect(resetFinished).toBe(false);

    mgr.releaseUser("ST");
    await reset;
    expect(session.close).toHaveBeenCalledOnce();
    expect(resetFinished).toBe(true);
  });

  it("reset closes immediately when only command holds remain", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
    mgr.bumpCommand("ST");

    await mgr.resetWhenUnused("ST");

    expect(session.close).toHaveBeenCalledOnce();
    expect(mgr.has("ST")).toBe(false);
  });

  it("closeAll closes every live session and clears timers", async () => {
    const mgr = managerFor("wired");
    const a = fakeSession("a");
    const b = fakeSession("b");
    await mgr.acquire("A", async () => a);
    await mgr.acquire("B", async () => b);
    await mgr.closeAll();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(mgr.size).toBe(0);
  });

  it("register makes a session live without arming any idle timer", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    mgr.register("ST", session);
    expect(mgr.get("ST")).toBe(session);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(session.close).not.toHaveBeenCalled();
  });
});
