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
 * holds one consumer while any viewer is attached; a control command and a speculative pre-warm (e.g. a
 * doorbell ring) each take a **hold**, a consumer that releases itself when its timer expires. When the
 * counter hits zero the idle timer arms; a new consumer cancels it. `wired` stations use an infinite
 * window (never auto-close); `battery` stations a short one.
 *
 * A hold is distinguished from an attached consumer only for {@link SessionManager.resetWhenUnused},
 * which may close through expiring holds but must wait for a real viewer.
 *
 * @module transport/p2p/session-manager
 */
import { Timer } from "../../core/util.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import type { P2PSession } from "./p2p-session.js";

/** A station's power tier — governs its idle window. */
export type PowerTier = "wired" | "battery";

/**
 * A station open was abandoned because its entry was closed or superseded while the factory ran.
 *
 * Distinct from a connect failure: nothing is wrong with the device, the caller's reason to open it
 * simply stopped applying. A speculative caller treats this as a non-event; anyone who asked for the
 * session on a caller's behalf must still surface it.
 */
export class SessionSupersededError extends Error {}

/** Default idle window for a battery station before its session is closed to let the device sleep. */
export const BATTERY_IDLE_MS = 300_000;
/** How long a single control command holds a session warm after dispatch (a burst keeps re-holding). */
export const COMMAND_KEEPALIVE_MS = 15_000;
/**
 * Default window a speculative pre-warm (e.g. after a doorbell ring) holds its user for. Expiring
 * releases that user; it does not close the session — the station's own idle window then runs, so an
 * unattended pre-warm on a battery station costs this plus {@link BATTERY_IDLE_MS}.
 */
export const PREWARM_MS = 28_000;

/**
 * Per-station lifecycle state. `session` is the live connection (absent while cold); `consumers` counts
 * the active reasons to stay connected; `holdTimers` is the subset of those that expire on their own, so
 * its size IS the hold count and a discarded entry cannot leave one running; `idle` is armed only when
 * `consumers` is zero; `connecting` coalesces concurrent cold opens.
 *
 * The power tier is deliberately NOT stored: it is resolved per idle-arm, so a station whose battery
 * evidence arrives after its first session still gets the right window.
 */
interface SessionEntry {
  session?: P2PSession;
  consumers: number;
  holdTimers: Set<ReturnType<typeof setTimeout>>;
  resetPending: boolean;
  resetWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  idle: Timer;
  connecting?: Promise<P2PSession>;
}

export interface SessionManagerOpts {
  /** Idle window for battery stations (ms). Default {@link BATTERY_IDLE_MS}. */
  batteryIdleMs?: number;
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

  /** Get or create the lifecycle entry for a station. */
  private entry(parentSn: string): SessionEntry {
    let e = this.entries.get(parentSn);
    if (!e) {
      e = { consumers: 0, holdTimers: new Set(), resetPending: false, resetWaiters: [], idle: new Timer() };
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
      this.logger.debug(`[session ${parentSn}] connecting — joining in-flight open`);
      return e.connecting;
    }
    if (e.session) return e.session;
    this.logger.debug(`[session ${parentSn}] connecting now (on demand)`);
    const generation = this.generation;
    const p = factory((session) => (e.session = session));
    e.connecting = p;
    try {
      const session = await p;
      if (generation !== this.generation || this.entries.get(parentSn) !== e) {
        await session.close();
        throw new SessionSupersededError(`P2P session start superseded for station ${parentSn}`);
      }
      e.session ??= session;
      this.logger.debug(`[session ${parentSn}] connected`);
      return e.session;
    } finally {
      if (e.connecting === p) e.connecting = undefined;
    }
  }

  /** Add a reason to stay connected; cancels a pending idle-close. */
  addConsumer(parentSn: string): void {
    const e = this.entry(parentSn);
    e.consumers++;
    if (e.idle.pending) this.logger.debug(`[session ${parentSn}] in use again — idle-detach cancelled`);
    e.idle.cancel();
  }

  /**
   * Release a reason; arm the idle-close when the last one goes.
   *
   * A release with nothing counted is REFUSED rather than clamped to zero. Such a release belongs to no
   * consumer on this entry — it is a deferred release whose own entry was already discarded — and
   * letting it proceed would either restart a battery station's idle window from scratch or complete a
   * deferred reset that someone else is still waiting to earn.
   */
  releaseConsumer(parentSn: string): void {
    const e = this.entries.get(parentSn);
    if (!e) return;
    if (e.consumers === 0) {
      this.logger.warn(`[session ${parentSn}] release with no consumer counted — ignored`);
      return;
    }
    e.consumers -= 1;
    if (e.resetPending && e.consumers <= e.holdTimers.size) {
      void this.close(parentSn).catch((error) =>
        this.logger.error(`[session ${parentSn}] deferred reset failed`, error),
      );
      return;
    }
    if (e.consumers === 0) this.armIdle(parentSn, e);
  }

  /**
   * Hold a session warm for `commandKeepAliveMs` after a control command, then release. A burst of
   * commands each re-holds before the previous release fires, so the session never idles mid-burst.
   */
  bumpCommand(parentSn: string): void {
    this.hold(parentSn, this.opts.commandKeepAliveMs ?? COMMAND_KEEPALIVE_MS);
  }

  /**
   * Take a consumer that releases itself after `ms` — the primitive behind command-keepalive and event
   * pre-warm, and the only way to hold a station without an attachment to release it.
   *
   * The timer is owned by the entry, so {@link discard} cancels it. That ownership is the point: keyed
   * only by serial, an expiring hold would otherwise outlive the entry it was taken on and release a
   * consumer counted by the SUCCESSOR entry — dropping a live viewer's count and arming an idle-detach
   * underneath it.
   */
  hold(parentSn: string, ms: number): void {
    const entry = this.entry(parentSn);
    this.addConsumer(parentSn);
    const timer = setTimeout(() => {
      entry.holdTimers.delete(timer);
      this.releaseConsumer(parentSn);
    }, ms);
    timer.unref?.();
    entry.holdTimers.add(timer);
  }

  /**
   * Arm the idle-close timer for a station whose consumer count just reached zero. A wired station with
   * an infinite window is left persistent (no timer). Any subsequent {@link addConsumer} cancels it.
   */
  private armIdle(parentSn: string, e: SessionEntry): void {
    e.idle.cancel();
    if ((this.opts.poweredFor?.(parentSn) ?? "wired") !== "battery") {
      this.logger.debug(`[session ${parentSn}] idle (0 consumers) — staying persistent (wired)`);
      return;
    }
    const idleMs = this.opts.batteryIdleMs ?? BATTERY_IDLE_MS;
    this.logger.debug(`[session ${parentSn}] idle (0 consumers) — detaching in ${idleMs}ms unless reused`);
    e.idle.arm(idleMs, () => this.onIdle(parentSn));
  }

  /**
   * Close a station's session once its idle window elapses with no consumers, letting the device sleep.
   * Re-checks the count first (activity between the timer firing and now re-arms instead). Dropping the
   * entry here and the session's own `close` → {@link remove} are both idempotent.
   */
  private onIdle(parentSn: string): void {
    const e = this.entries.get(parentSn);
    if (!e) return;
    if (e.consumers > 0) return;
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

  /** Reset after active consumers detach, ignoring only expiring holds. */
  async resetWhenUnused(parentSn: string): Promise<void> {
    const entry = this.entries.get(parentSn);
    if (!entry) return;
    if (entry.consumers <= entry.holdTimers.size) {
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

  /**
   * Discard one lifecycle entry and return it for bounded close/reset completion.
   *
   * Every timer the entry owns dies with it — the idle window and any hold still counting down. A
   * discarded entry owns no live timer, which is what stops a deferred release from landing on whatever
   * entry next occupies this serial.
   */
  private discard(parentSn: string): SessionEntry | undefined {
    const entry = this.entries.get(parentSn);
    if (!entry) return undefined;
    entry.idle.cancel();
    for (const timer of entry.holdTimers) clearTimeout(timer);
    entry.holdTimers.clear();
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
