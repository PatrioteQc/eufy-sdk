/**
 * The single, concrete {@link Device} class.
 *
 * There are **no subclasses**. A device's behaviour is entirely determined by its resolved
 * `{ codec, capabilities, properties }` (see `resolveDevice`). Code asks
 * `device.has("light")` / `device.getProperty("battery")` — never `instanceof FloodlightCamera`.
 *
 * Live state is held as a flat map of `PropertyValue`, updated by feeding raw param maps
 * (from the cloud record or P2P notifications) into {@link Device.applyParams}. Params the model
 * doesn't recognise are **not dropped** — they are kept as `unknown_<paramType>` passthrough, so
 * coverage can grow later without losing data today (the graceful-unknown rule, applied to params).
 *
 * @module model/device
 */

import type {
  Capability,
  CloudRecord,
  CommandContext,
  ParamEncoding,
  ParamValue,
  PropertyValueType,
  PropertySpec,
  PropertyValue,
  ResolvedDevice,
} from "./types.js";
import type { CommandSink, MediaProvider, Ff09SettingsReader, RawDpCodec } from "../core/contracts.js";
import { noopLogger, type Logger } from "../core/logger.js";
import { structuralEqual } from "../core/util.js";
import { resolveDevice } from "./registry.js";
import {
  buildActions,
  accessorNamesFor,
  describeCapabilities,
  type DeviceActionMap,
  type CapabilityAccessors,
  type DeviceManifest,
} from "./capabilities/index.js";
import { paramDef, namespaceForCodec, type ParamNamespace } from "./param-namespace.js";

/**
 * Decode an encoded wire value (base64-wrapped JSON or a JSON string) to its structured form —
 * e.g. motion-detection zones, privacy zones, guard-mode configs. Falls back to the raw string if
 * decoding fails, so a malformed value never throws.
 */
function decodeEncoded(raw: string | number | boolean, encoding: ParamEncoding): ParamValue {
  const s = String(raw);
  try {
    if (encoding === "base64+json") {
      return JSON.parse(Buffer.from(s, "base64").toString("utf8")) as ParamValue;
    }
    return JSON.parse(s) as ParamValue; // "json"
  } catch {
    return s;
  }
}

/** Prefix used for params that have no `PropertySpec` mapping yet. */
export const UNKNOWN_PARAM_PREFIX = "unknown_";

/** A raw param map as delivered by the cloud / P2P: param_type → raw value. */
export type RawParams = Record<number | string, string | number | boolean>;

/**
 * Coerce a raw wire value to the declared `PropertySpec.type`. Wire values arrive as strings (cloud)
 * or numbers (P2P); this normalises them. A `number`/`enum` whose raw value is not numeric — a
 * HomeBase sometimes returns a raw string / JSON blob where a scalar is expected — is kept as the raw
 * string (never lie-cast to `NaN`) and logged at `warn`: the typed getters (`readNum`) surface a
 * non-number as `undefined`, so the log is the only signal of the mismatch. `logger` defaults silent.
 */
function coerceByType(
  type: PropertyValueType,
  raw: string | number | boolean,
  name?: string,
  logger: Logger = noopLogger,
): boolean | number | string {
  switch (type) {
    case "bool":
      return raw === true || raw === 1 || raw === "1" || raw === "true";
    case "number":
    case "enum": {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
      logger.warn(
        `[device] property "${name ?? "?"}" declared "${type}" but wire value is not numeric — keeping raw`,
        raw,
      );
      return String(raw);
    }
    case "string":
    default:
      return String(raw);
  }
}

function coerce(
  spec: PropertySpec,
  raw: string | number | boolean,
  invert = false,
  logger: Logger = noopLogger,
): boolean | number | string {
  // A custom decode (e.g. a bitfield the app reinterprets) fully owns the value — no type-coerce/invert.
  if (spec.decode) return spec.decode(raw);
  const v = coerceByType(spec.type, raw, spec.name, logger);
  // A `bool` param that is a disable flag reads inverted ("0"/false ⇒ TRUE). `invert` comes from
  // the spec (its own paramType) or the matched read-alias — see specByParam construction.
  return spec.type === "bool" && invert ? !v : v;
}

/**
 * A eufy device: one class, capability-driven. Construct from a resolved record (or a raw
 * `CloudRecord` via {@link Device.fromRecord}), then feed it param updates.
 */
export class Device {
  /** Serial number (station/device SN). */
  readonly sn: string;
  /** Resolved command-codec family. */
  codec!: ResolvedDevice["codec"];
  /** Resolved capability set. Widens if the device later reports evidence for more. */
  capabilities!: readonly Capability[];
  /** Merged property schema (one entry per known property this device exposes). */
  properties!: readonly PropertySpec[];
  /** Display name. */
  name!: string;
  /** Which resolver tier produced the codec/caps. */
  source!: ResolvedDevice["source"];

  /** Fast capability lookup. */
  private capSet!: ReadonlySet<Capability>;
  /** propertyName → spec, for applyParams. */
  private specByName!: ReadonlyMap<string, PropertySpec>;
  /**
   * paramType → { spec, invert } for applyParams. Includes each spec's own `paramType` (invert
   * from the spec) plus any `readAliases` (invert from the alias) so a property that rides
   * different wire ids across device families still resolves to one named value.
   */
  private specByParam!: ReadonlyMap<number, { spec: PropertySpec; invert: boolean }>;
  /** Which param namespace this device's ids live in (clean DPs vs security P2P). */
  private namespace!: ParamNamespace;
  /** Live property values, keyed by property name (or `unknown_<pt>`). */
  private readonly state = new Map<string, PropertyValue>();
  /**
   * Bound action objects per capability the device HAS, keyed by camelCased capability id
   * (`light`, `ptz`, `camera`). Empty until {@link bindActions} runs — a bare model object
   * (no network) has no actions. Populated by `EufyMega.getDevice`; surfaced through the fluent
   * `dev.<cap>()` accessors ({@link CapabilityAccessors}).
   */
  private actionMap: Partial<DeviceActionMap> = {};
  /**
   * Whether {@link bindActions} has run — published through {@link describe} because an unbound device
   * has no bound objects to enumerate, and "exposes nothing" and "not wired up yet" are different
   * answers a caller has to be able to tell apart.
   */
  private bound = false;

  /**
   * Read-through freshness policy (injected by the facade via {@link setFreshnessPolicy}; the model
   * stays transport-free — it only calls the supplied `refresh`). Default: caching OFF
   * (`staleAfterMs = Infinity`), so a bare model object never triggers a fetch and existing behaviour
   * is unchanged until the client wires a policy.
   */
  private staleAfterMs = Infinity;
  private refresher?: () => Promise<void>;
  /** Guards against firing more than one background refresh at a time (coalesces rapid stale reads). */
  private refreshInFlight = false;
  /**
   * Host-supplied diagnostics sink. Defaults to {@link noopLogger} (silent) so a bare model object
   * stays quiet; the facade passes its own `logger` through {@link fromRecord}. Used to WARN when a
   * wire value doesn't match its declared `PropertySpec.type` (see {@link coerceByType}).
   */
  private readonly logger: Logger;

  constructor(sn: string, resolved: ResolvedDevice, logger: Logger = noopLogger) {
    this.sn = sn;
    this.logger = logger;
    this.resolveInto(resolved);
  }

  /**
   * Adopt a resolution: the capability set, the property schema, and everything derived from them.
   *
   * Shared by the constructor and {@link reresolve} so a widened device is indistinguishable from one
   * that resolved that way to begin with — a second derivation path here would be a slow-drifting bug,
   * since only the re-resolve case would exercise it.
   */
  private resolveInto(resolved: ResolvedDevice): void {
    this.codec = resolved.codec;
    this.capabilities = resolved.capabilities;
    this.properties = resolved.properties;
    this.name = resolved.name;
    this.source = resolved.source;
    this.capSet = new Set(resolved.capabilities);
    this.specByName = new Map(resolved.properties.map((p) => [p.name, p]));
    const byParam = new Map<number, { spec: PropertySpec; invert: boolean }>();
    for (const p of resolved.properties) {
      // Own param first (wins on conflict), then read-aliases. First writer wins so an earlier
      // capability's own param is never clobbered by a later capability's alias.
      if (!byParam.has(p.paramType)) byParam.set(p.paramType, { spec: p, invert: p.invert ?? false });
      for (const a of p.readAliases ?? [])
        if (!byParam.has(a.paramType)) byParam.set(a.paramType, { spec: p, invert: a.invert ?? false });
    }
    this.specByParam = byParam;
    this.namespace = namespaceForCodec(resolved.codec);
    this.installAccessors();
  }

  /**
   * Re-resolve against a fresher record and adopt the result if the capability set grew.
   *
   * A capability is granted on evidence the device reports, so a device that hadn't reported a param
   * when it was first resolved lacks the capability that param proves — and would keep lacking it for
   * the object's whole lifetime, even as the value itself started arriving. Re-resolving on fresh
   * evidence closes that: the accessor appears, already bound if the device is bound.
   *
   * Only ever widens. A param the device stops reporting does not retract a capability, because the
   * cloud record is a snapshot that can lose a field for reasons that have nothing to do with the
   * hardware, and revoking an accessor a caller already holds is worse than keeping a quiet one.
   *
   * Returns the capabilities gained, empty when nothing changed — so a caller can skip re-binding.
   */
  reresolve(rec: CloudRecord): Capability[] {
    const next = resolveDevice(rec);
    const gained = next.capabilities.filter((c) => !this.capSet.has(c));
    if (!gained.length) return [];
    this.resolveInto({ ...next, capabilities: [...new Set([...this.capabilities, ...next.capabilities])] });
    return gained;
  }

  /**
   * Wire this device to a {@link CommandSink} so its semantic action objects become live
   * (`device.light?.on()`). `ctx` carries the evidence a capability uses to resolve the right
   * command variant. Called by `EufyMega.getDevice`; a raw model object left unbound simply has
   * no action objects (all accessors return `undefined`). `ff09Settings` reads that frame family's
   * settings over whichever transport the device has; `rawDp` reads the structured payloads a few params
   * carry in place of a scalar. Both are optional and both are named for the job, not the caller — a
   * read needing one returns `undefined` without it. See `CapabilityModule.actions`'s doc before
   * threading a third. The final `buildActions` arg is the live-state reader backing the capabilities' typed
   * read getters (`dev.battery()?.level`): it closes over `this.getProperty`, so a getter built once
   * here stays current as realtime/poll updates land in `this.state`.
   */
  bindActions(
    ctx: CommandContext,
    sink: CommandSink,
    media?: MediaProvider,
    ff09Settings?: Ff09SettingsReader,
    rawDp?: RawDpCodec,
  ): void {
    this.actionMap = buildActions(this.capabilities, ctx, sink, media, ff09Settings, rawDp, (name) =>
      this.getProperty(name),
    );
    this.bound = true;
  }

  /**
   * Install the fluent capability accessors (`dev.ptz()`, `dev.light()`, …) once, for EVERY
   * known accessor name — each reads `this.actionMap` live, so an accessor returns `undefined`
   * (never "not a function") on an unbound device or one lacking the capability, and starts
   * returning the action object after {@link bindActions}. Capability-agnostic: the names come
   * from the barrel projection {@link accessorNamesFor}, so `device.ts` never names a
   * capability. The single cast here is the only place the {@link CapabilityAccessors} types erase.
   */
  private installAccessors(): void {
    for (const name of accessorNamesFor(new Set(this.capabilities))) {
      (this as unknown as Record<string, () => unknown>)[name] = () => this.actionMap[name];
    }
  }

  /** Build a Device from a raw cloud record (runs the 3-tier resolver). */
  static fromRecord(sn: string, rec: CloudRecord, logger: Logger = noopLogger): Device {
    const dev = new Device(sn, resolveDevice(rec), logger);
    if (rec.params) dev.applyParams(rec.params);
    return dev;
  }

  /** Does this device have the given capability? */
  has(cap: Capability): boolean {
    return this.capSet.has(cap);
  }

  /** Is the given property name part of this device's schema? */
  hasProperty(name: string): boolean {
    return this.specByName.has(name);
  }

  /**
   * Wire a read-through freshness policy. When a cached property is older than `staleAfterMs`, a
   * `getProperty`/`getProperties` read schedules ONE coalesced background `refresh()` (the facade
   * supplies it, choosing the cheapest live transport) and returns the last-known value immediately —
   * reads never block. Push / P2P realtime updates refresh `ts` themselves via {@link applyParams}, so
   * a device kept fresh by realtime never re-fetches (a fresh entry is never stale). Keeps `model/`
   * transport-free: the device only calls the injected callback.
   */
  setFreshnessPolicy(policy: { staleAfterMs: number; refresh: () => Promise<void> }): void {
    this.staleAfterMs = policy.staleAfterMs;
    this.refresher = policy.refresh;
  }

  /**
   * Low-level property read by name — the untyped escape hatch. **Prefer the typed fluent capability
   * getters** (`dev.battery()?.level`, `dev.contact()?.open`) where the property is exposed by a
   * capability: they return the value already narrowed to its declared type instead of the loose
   * `PropertyValue.value` (`boolean|number|string|object`) you get here. Use this only for an unbound
   * model object (no live client → no `dev.<cap>()`) or a param not yet surfaced on a capability.
   * Returns `undefined` if never observed.
   */
  getProperty(name: string): PropertyValue | undefined {
    const v = this.state.get(name);
    if (v && Date.now() - v.ts > this.staleAfterMs) this.scheduleRefresh();
    return v;
  }

  /**
   * Snapshot of all current property values (named + unknown passthrough) — the untyped bulk read, for
   * diagnostics / discovery. **Prefer the typed fluent capability getters** (`dev.battery()?.level`, …)
   * for reading a specific known property; this loose map is for dumping everything (e.g. the CLI /
   * device inspector), not per-property access. Under a freshness policy, schedules a background refresh
   * when the OLDEST observed value is stale (one fetch covers every param) and returns the current
   * snapshot immediately.
   */
  getProperties(): Record<string, PropertyValue> {
    if (this.refresher && !this.refreshInFlight) {
      let oldest: number | undefined;
      for (const v of this.state.values()) oldest = oldest === undefined ? v.ts : Math.min(oldest, v.ts);
      if (oldest !== undefined && Date.now() - oldest > this.staleAfterMs) this.scheduleRefresh();
    }
    return Object.fromEntries(this.state);
  }

  /**
   * Fire the injected background refresh at most once at a time (coalescing rapid stale reads). The
   * refresh calls {@link applyParams}, which updates each value's `ts` — so subsequent reads see fresh
   * entries and stop re-triggering until the next staleness window. Fire-and-forget; never throws to
   * the reader (a failed refresh just leaves the last-known value in place).
   */
  private scheduleRefresh(): void {
    if (!this.refresher || this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      void this.refresher().finally(() => {
        this.refreshInFlight = false;
      });
    } catch {
      // A refresher that throws SYNCHRONOUSLY (violating its `Promise<void>` contract) would otherwise
      // leave `refreshInFlight` stuck true — bricking every future refresh — and propagate to the
      // reader. Reset the flag and swallow it so a read never throws and refresh self-heals next time.
      this.refreshInFlight = false;
    }
  }

  /**
   * Apply a raw param map (cloud record or P2P notification). Known params update their named
   * property; unrecognised params are retained as `unknown_<paramType>` so nothing is lost.
   *
   * @param params param_type → raw value.
   * @param ts observation time (epoch ms); defaults to `Date.now()`.
   * @returns the list of property names whose value changed.
   */
  applyParams(params: RawParams, ts: number = Date.now()): string[] {
    const changed: string[] = [];
    for (const [rawKey, rawVal] of Object.entries(params)) {
      const pt = Number(rawKey);
      if (!Number.isFinite(pt)) continue;
      // Naming precedence: a capability's PropertySpec (curated) → the param dictionary (all
      // known ids in this namespace) → `unknown_<pt>` passthrough (never dropped). The dict def is
      // always consulted (even when a capability spec exists) because `encoding` lives there.
      const hit = this.specByParam.get(pt);
      const spec = hit?.spec;
      const def = paramDef(this.namespace, pt);
      const name = spec ? spec.name : def ? def.name : `${UNKNOWN_PARAM_PREFIX}${pt}`;
      const value: ParamValue = def?.encoding
        ? decodeEncoded(rawVal, def.encoding) // base64+json / json → structured object
        : spec
          ? coerce(spec, rawVal, hit!.invert, this.logger)
          : def
            ? coerceByType(def.type, rawVal, def.name, this.logger)
            : String(rawVal);
      const prev = this.state.get(name);
      // Compare structurally (order-insensitive) so a decoded object whose keys come back reordered
      // doesn't read as "changed" and flap a downstream update — see `structuralEqual`.
      const changedVal = prev === undefined || !structuralEqual(prev.value, value);
      this.state.set(name, { name, paramType: pt, value, ts });
      if (changedVal) changed.push(name);
    }
    return changed;
  }

  /**
   * What this device exposes, as data — the shape a caller renders a device from without a branch per
   * capability: every installed read with what its value MEANS, every offerable action with what it
   * accepts, and every event each capability emits.
   *
   * Beside {@link toJSON} rather than folded into it, because the two answer different questions and
   * `toJSON` fires on every implicit `JSON.stringify` (an event payload, a log line) where the shape is
   * not wanted. This one carries **shape only** — no values; read those through the capability getters
   * it names.
   *
   * The reads and actions are the ones this device actually installed, so a caller can offer everything
   * listed: a write the device gave no evidence for, or one whose wire is not confirmed, is absent
   * rather than described. An unbound device (no live client) has nothing bound to enumerate and answers
   * `bound: false` with empty `details`.
   */
  describe(): DeviceManifest {
    return {
      sn: this.sn,
      name: this.name,
      codec: this.codec,
      source: this.source,
      bound: this.bound,
      capabilities: [...this.capabilities],
      details: describeCapabilities(this.actionMap),
    };
  }

  /** Plain-object view, handy for the CLI / discovery / debugging. */
  toJSON(): Record<string, unknown> {
    return {
      sn: this.sn,
      name: this.name,
      codec: this.codec,
      source: this.source,
      capabilities: [...this.capabilities],
      properties: this.getProperties(),
    };
  }
}

/**
 * Declaration merge: give {@link Device} the fluent capability accessors (`dev.ptz()`,
 * `dev.light()`, `dev.camera()`, …) with full IDE typing, WITHOUT `device.ts` naming a single
 * capability. The accessor names + return types come from {@link CapabilityAccessors} (a projection
 * of the capability modules in the barrel); `bindActions` installs the matching closures at runtime.
 * Adding a capability adds an accessor here automatically — no edit to this file.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Device extends CapabilityAccessors {}
