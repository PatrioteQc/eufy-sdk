/**
 * P2P session lifecycle manager — owns the per-station {@link P2PSession} registry and decides WHEN a
 * session is open. It exists to stop battery-powered cameras draining: a persistent P2P session runs a
 * 5 s PING heartbeat forever (keeping the device awake), so instead of opening every station eagerly
 * and holding it open, this opens a station's session **on demand** (first command / stream / pre-warm)
 * and **auto-closes** it after an idle window whose length depends on the station's power tier.
 *
 * Pure transport: it knows nothing about capabilities or events. The power tier per station
 * (`wired` = mains HomeBase / plugged camera → persistent; `battery` = standalone battery cam → short
 * idle-detach) is injected as plain data via {@link SessionManagerOpts.poweredFor} by the facade, so
 * `model/` is never imported here (the decorrelation invariant).
 *
 * Refcount model — ONE counter per station, shared by every "reason to stay connected": a live stream
 * holds one user while any consumer is attached; a control command holds a short keepalive so a burst
 * stays warm; a speculative pre-warm (e.g. a doorbell ring) holds a user for a window so a tap-to-view
 * is instant. When the counter hits zero the idle timer arms; a new user cancels it. `wired` stations
 * use an infinite window (never auto-close); `battery` stations a short one.
 *
 * @module transport/p2p/session-manager
 */
import { Timer } from "../../core/util.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import type { P2PSession } from "./p2p-session.js";

/** A station's power tier — governs its idle window. */
export type PowerTier = "wired" | "battery";

/** Default idle window for a battery station before its session is closed to let the device sleep. */
export const BATTERY_IDLE_MS = 300_000;
/** How long a single control command holds a session warm after dispatch (a burst keeps re-holding). */
export const COMMAND_KEEPALIVE_MS = 15_000;
/** Default speculative pre-warm window (e.g. after a doorbell ring) before auto-detach if unused. */
export const PREWARM_MS = 28_000;

/**
 * Per-station lifecycle state. `session` is the live connection (absent while cold); `users` counts the
 * active reasons to stay connected; `idle` is armed only when `users` is zero; `idleMs` is the resolved
 * window (`Infinity` = persistent); `connecting` coalesces concurrent cold opens.
 */
interface SessionEntry {
  session?: P2PSession;
  users: number;
  holds: number;
  resetPending: boolean;
  resetWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  idle: Timer;
  powered: PowerTier;
  idleMs: number;
  connecting?: Promise<P2PSession>;
}

export interface SessionManagerOpts {
  /** Idle window for battery stations (ms). Default {@link BATTERY_IDLE_MS}. */
  batteryIdleMs?: number;
  /** Idle window for wired stations (ms). Default `Infinity` (persistent). */
  wiredIdleMs?: number;
  /** Keepalive a single command holds after dispatch (ms). Default {@link COMMAND_KEEPALIVE_MS}. */
  commandKeepAliveMs?: number;
  /** Power tier per station serial — injected by the facade (no model import). Default: everything `wired`. */
  poweredFor?: (parentSn: string) => PowerTier;
  /** Diagnostics sink for the lifecycle transitions (open / idle-arm / detach). Omit for silence. */
  logger?: Logger;
}

/**
 * Manages P2P sessions keyed by **parent station serial**. The router builds/wires the actual
 * `P2PSession` (it owns the socket + event fan-out); this decides open/close timing.
 */
export class SessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  /** Invalidates station factories that finish after {@link closeAll}. */
  private generation = 0;
  private readonly logger: Logger;

  constructor(private readonly opts: SessionManagerOpts = {}) {
    this.logger = opts.logger ?? noopLogger;
  }

  /** The live session for a station, or `undefined` if not open. */
  get(parentSn: string): P2PSession | undefined {
    return this.entries.get(parentSn)?.session;
  }

  /** Whether a station has a live session. */
  has(parentSn: string): boolean {
    return this.entries.get(parentSn)?.session !== undefined;
  }

  /** Serials of stations with a live session. */
  keys(): string[] {
    return [...this.entries].filter(([, e]) => e.session).map(([sn]) => sn);
  }

  /** Number of stations with a live session. */
  get size(): number {
    return this.keys().length;
  }

  /** A plain `Map<parentSn, P2PSession>` snapshot of the live sessions (for `getSessions()` / tests). */
  liveSessions(): Map<string, P2PSession> {
    const m = new Map<string, P2PSession>();
    for (const [sn, e] of this.entries) if (e.session) m.set(sn, e.session);
    return m;
  }

  /** Resolve a station's power tier + idle window from the injected {@link SessionManagerOpts.poweredFor}. */
  private resolvePower(parentSn: string): { powered: PowerTier; idleMs: number } {
    const powered = this.opts.poweredFor?.(parentSn) ?? "wired";
    const idleMs =
      powered === "battery" ? (this.opts.batteryIdleMs ?? BATTERY_IDLE_MS) : (this.opts.wiredIdleMs ?? Infinity);
    return { powered, idleMs };
  }

  /** Get or create the lifecycle entry for a station (resolving its power tier once, lazily). */
  private entry(parentSn: string): SessionEntry {
    let e = this.entries.get(parentSn);
    if (!e) {
      const { powered, idleMs } = this.resolvePower(parentSn);
      e = { users: 0, holds: 0, resetPending: false, resetWaiters: [], idle: new Timer(), powered, idleMs };
      this.entries.set(parentSn, e);
    }
    return e;
  }

  /** Register an already-built session for test seeding or an externally assembled connection. */
  register(parentSn: string, session: P2PSession): void {
    this.entry(parentSn).session = session;
  }

  /**
   * Ensure a session to `parentSn` is open, building it via `factory` if cold. Concurrent calls for the
   * same cold station share ONE connect (the `connecting` promise); `factory` builds + wires + awaits
   * `connect()` and resolves the connected session.
   */
  async acquire(
    parentSn: string,
    factory: (register: (session: P2PSession) => void) => Promise<P2PSession>,
  ): Promise<P2PSession> {
    const e = this.entry(parentSn);
    if (e.connecting) {
      this.logger.debug(`[session ${parentSn}] connecting — joining in-flight open (${e.powered})`);
      return e.connecting;
    }
    if (e.session) return e.session;
    this.logger.debug(`[session ${parentSn}] connecting now (${e.powered}, on demand)`);
    const generation = this.generation;
    const p = factory((session) => (e.session = session));
    e.connecting = p;
    try {
      const session = await p;
      if (generation !== this.generation || this.entries.get(parentSn) !== e) {
        await session.close();
        throw new Error(`P2P session start superseded for station ${parentSn}`);
      }
      e.session ??= session;
      this.logger.debug(`[session ${parentSn}] connected`);
      return e.session;
    } finally {
      if (e.connecting === p) e.connecting = undefined;
    }
  }

  /** Add a reason to stay connected; cancels a pending idle-close. */
  addUser(parentSn: string): void {
    const e = this.entry(parentSn);
    e.users++;
    if (e.idle.pending) this.logger.debug(`[session ${parentSn}] in use again — idle-detach cancelled`);
    e.idle.cancel();
  }

  /** Release a reason; arm the idle-close when the last one goes. */
  releaseUser(parentSn: string): void {
    const e = this.entries.get(parentSn);
    if (!e) return;
    e.users = Math.max(0, e.users - 1);
    if (e.resetPending && e.users <= e.holds) {
      void this.close(parentSn).catch((error) =>
        this.logger.error(`[session ${parentSn}] deferred reset failed`, error),
      );
      return;
    }
    if (e.users === 0) this.armIdle(parentSn, e);
  }

  /**
   * Hold a session warm for `commandKeepAliveMs` after a control command, then release. A burst of
   * commands each re-holds before the previous release fires, so the session never idles mid-burst.
   */
  bumpCommand(parentSn: string): void {
    this.hold(parentSn, this.opts.commandKeepAliveMs ?? COMMAND_KEEPALIVE_MS);
  }

  /** Add a user then auto-release after `ms` — the primitive behind command-keepalive + event pre-warm. */
  hold(parentSn: string, ms: number): void {
    const entry = this.entry(parentSn);
    this.addUser(parentSn);
    entry.holds += 1;
    setTimeout(() => this.releaseHold(parentSn), ms).unref?.();
  }

  /** Release one expiring hold without counting it as an active session consumer. */
  private releaseHold(parentSn: string): void {
    const entry = this.entries.get(parentSn);
    if (!entry) return;
    entry.holds = Math.max(0, entry.holds - 1);
    this.releaseUser(parentSn);
  }

  /**
   * Arm the idle-close timer for a station whose user count just reached zero. A wired station with an
   * infinite window is left persistent (no timer). Any subsequent {@link addUser} cancels the timer.
   */
  private armIdle(parentSn: string, e: SessionEntry): void {
    e.idle.cancel();
    if (!Number.isFinite(e.idleMs)) {
      this.logger.debug(`[session ${parentSn}] idle (0 users) — staying persistent (${e.powered})`);
      return;
    }
    this.logger.debug(`[session ${parentSn}] idle (0 users) — detaching in ${e.idleMs}ms unless reused`);
    e.idle.arm(e.idleMs, () => this.onIdle(parentSn));
  }

  /**
   * Close a station's session once its idle window elapses with no users, letting the device sleep. Re-
   * checks the user count first (activity between the timer firing and now re-arms instead). Dropping
   * the entry here and the session's own `close` → {@link remove} are both idempotent.
   */
  private onIdle(parentSn: string): void {
    const e = this.entries.get(parentSn);
    if (!e) return;
    if (e.users > 0) return;
    this.logger.debug(`[session ${parentSn}] idle window elapsed — disconnecting now (device can sleep)`);
    void this.close(parentSn).catch((error) => this.logger.error(`[session ${parentSn}] idle detach failed`, error));
  }

  /** Drop a station's entry + timer (called from the session's `close` handler). Idempotent. */
  remove(parentSn: string): void {
    const entry = this.discard(parentSn);
    if (entry) this.settleResetWaiters(entry);
  }

  /** Close one station now and discard its lifecycle entry. */
  async close(parentSn: string): Promise<void> {
    const entry = this.discard(parentSn);
    if (entry) await this.closeEntry(entry);
  }

  /** Reset after active consumers detach, ignoring only expiring command holds. */
  async resetWhenUnused(parentSn: string): Promise<void> {
    const entry = this.entries.get(parentSn);
    if (!entry) return;
    if (entry.users <= entry.holds) {
      await this.close(parentSn);
      return;
    }
    entry.resetPending = true;
    return new Promise<void>((resolve, reject) => entry.resetWaiters.push({ resolve, reject }));
  }

  /** Settle a discarded entry's reset callers with the same outcome as its session close. */
  private settleResetWaiters(entry: SessionEntry, failure?: { error: unknown }): void {
    const waiters = entry.resetWaiters.splice(0);
    for (const waiter of waiters) {
      if (failure) waiter.reject(failure.error);
      else waiter.resolve();
    }
  }

  /** Close one discarded entry and settle only its own reset callers before preserving any failure. */
  private async closeEntry(entry: SessionEntry): Promise<void> {
    try {
      await entry.session?.close();
      this.settleResetWaiters(entry);
    } catch (error) {
      this.settleResetWaiters(entry, { error });
      throw error;
    }
  }

  /** Discard one lifecycle entry and return it for bounded close/reset completion. */
  private discard(parentSn: string): SessionEntry | undefined {
    const entry = this.entries.get(parentSn);
    if (!entry) return undefined;
    entry.idle.cancel();
    this.entries.delete(parentSn);
    return entry;
  }

  /** Close every session and clear all timers. */
  async closeAll(): Promise<void> {
    this.generation++;
    const entries = [...this.entries.keys()].flatMap((parentSn) => {
      const entry = this.discard(parentSn);
      return entry ? [entry] : [];
    });
    const results = await Promise.allSettled(entries.map((entry) => this.closeEntry(entry)));
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "multiple P2P sessions failed to close");
  }
}
