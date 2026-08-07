import { buildActions, CAPABILITY_MODULES, describeCapabilities } from "../index.js";
import { Device } from "../../device.js";
import type { Capability } from "../../types.js";
import type { CapabilityModule, CommandContext } from "../types.js";
import type { ValueMember } from "../members.js";
import type { Command, CommandSink, MediaProvider } from "../../../core/contracts.js";

/**
 * The manifest is the SDK's answer to "what does this device expose" for a caller outside the package,
 * so what it claims has to be true of the object a caller then reaches for. What this locks:
 *
 *  1. an unbound device says so, rather than describing itself as exposing nothing,
 *  2. the described reads are the INSTALLED ones — the evidence gate is observable from outside,
 *  3. enumeration and the member tables agree, so "read the live object" is safe rather than merely
 *     convenient — this is what fails if someone hand-writes a getter in an `actions()` factory,
 *  4. describing a device reads no VALUES: no getter is invoked and nothing observed leaks in,
 *  5. it survives a JSON round-trip, since a host consumes it over a wire it does not share with us,
 *  6. a provider-gated method is described only on a device bound to that provider.
 */
const MODULES = Object.values(CAPABILITY_MODULES);
const BINDABLE = MODULES.filter((m) => m.actions || m.members);
const sink: CommandSink = { dispatch: async () => undefined };
const camelCase = (id: string): string => id.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Every param any module reads — the "device reported everything" evidence set. */
const allParams = (): Set<number> => new Set(MODULES.flatMap((m) => m.properties.map((p) => p.paramType)));

const ctxWith = (paramIds: Set<number>): CommandContext => ({ channel: 0, codec: "camera", paramIds });

/** Describe the bound objects of a synthetic device that HAS every capability. */
const describeAll = (paramIds: Set<number>, media?: MediaProvider): ReturnType<typeof describeCapabilities> =>
  describeCapabilities(
    buildActions(
      BINDABLE.map((m) => m.capability),
      ctxWith(paramIds),
      sink,
      media,
      undefined,
      undefined,
      () => undefined,
    ),
  );

/**
 * The reads a module's table says a device with THESE params installs — the second computation the
 * builder deliberately does not do, kept here so the two can be compared.
 */
const tableReads = (m: CapabilityModule, paramIds: Set<number>): string[] =>
  Object.entries(m.members ?? {})
    .filter(([, member]) => "type" in member && !member.writeOnly && !member.unexposed)
    .filter(([, member]) => {
      const v = member as ValueMember;
      // A getter installs only where the member is available for this device — the same one
      // availability decision the manifest and setter apply (here the ctx is a plain camera).
      if (v.available && !v.available(ctxWith(paramIds))) return false;
      return (
        v.realtime === true ||
        (v.param !== undefined && paramIds.has(v.param)) ||
        v.readAliases?.some((a) => paramIds.has(a.paramType)) === true
      );
    })
    .map(([name]) => name);

describe("describeCapabilities — enumeration of the live bound objects", () => {
  it("agrees with the member tables on which reads a device installed", () => {
    const params = allParams();
    for (const d of describeAll(params)) {
      const module = CAPABILITY_MODULES[d.capability];
      expect(d.reads.map((r) => r.accessor).sort()).toEqual(tableReads(module, params).sort());
    }
  });

  it("describes only the reads the device reported, not the theoretical set", () => {
    const battery = CAPABILITY_MODULES.battery;
    const level = battery.members!.level as ValueMember;
    const only = describeAll(new Set([level.param!])).find((d) => d.capability === "battery")!;
    expect(only.reads.map((r) => r.accessor)).toEqual(["level"]);
    const all = describeAll(allParams()).find((d) => d.capability === "battery")!;
    expect(all.reads.length).toBeGreaterThan(1);
  });

  it("publishes what a value means, not just how it is stored", () => {
    const battery = describeAll(allParams()).find((d) => d.capability === "battery")!;
    expect(battery.reads.find((r) => r.accessor === "level")).toMatchObject({
      property: "battery",
      type: "number",
      kind: "percent",
      unit: "%",
      writable: false,
    });
  });

  it("names the accessor each capability is reached under", () => {
    for (const d of describeAll(allParams())) expect(d.accessor).toBe(camelCase(d.capability));
  });

  it("marks a read writable only where its own setter is installed beside it", () => {
    for (const d of describeAll(allParams())) {
      const bound = buildActions(
        [d.capability],
        ctxWith(allParams()),
        sink,
        undefined,
        undefined,
        undefined,
        () => undefined,
      )[camelCase(d.capability) as keyof ReturnType<typeof buildActions>] as Record<string, unknown>;
      const installed = Object.getOwnPropertyDescriptors(bound);
      for (const r of d.reads.filter((r) => r.writable)) {
        const member = CAPABILITY_MODULES[d.capability].members![r.accessor] as ValueMember;
        const setter = member.writeAs ?? `set${r.accessor[0].toUpperCase()}${r.accessor.slice(1)}`;
        expect(typeof installed[setter]?.value).toBe("function");
      }
    }
  });

  it("lists a described action by the name it is installed under, and the rest as undescribed", () => {
    for (const d of describeAll(allParams())) {
      const bound = buildActions(
        [d.capability],
        ctxWith(allParams()),
        sink,
        undefined,
        undefined,
        undefined,
        () => undefined,
      )[camelCase(d.capability) as keyof ReturnType<typeof buildActions>] as Record<string, unknown>;
      const methods = Object.entries(Object.getOwnPropertyDescriptors(bound))
        .filter(([, p]) => typeof p.value === "function")
        .map(([name]) => name);
      expect([...d.actions.map((a) => a.name), ...d.undescribedActions].sort()).toEqual(methods.sort());
    }
  });

  it("announces the events a capability emits, including the ones it decodes itself", () => {
    const described = describeAll(allParams());
    expect(described.find((d) => d.capability === "ptz")!.events).toEqual(["ptzNotify"]);
    expect([...described.find((d) => d.capability === "battery")!.events].sort()).toEqual([
      "batteryAlert",
      "batteryLevel",
    ]);
  });

  /**
   * The read's set and the action's are separate answers on purpose: a station reports nine guard modes
   * and can be SET to the three whose write was captured. Published together so a caller shows the current
   * mode from the labels and offers only what will be accepted — the same declaration the write itself is
   * checked against, so the offer cannot promise a refusal.
   */
  it("offers what an action accepts, not everything its read reports", () => {
    const arming = describeAll(allParams()).find((d) => d.capability === "arming")!;
    expect(arming.reads.find((r) => r.accessor === "mode")!.values).toEqual([0, 1, 2, 3, 4, 5, 6, 47, 63]);
    expect(arming.actions.find((a) => a.name === "setMode")!.args![0].values).toEqual([0, 1, 63]);
  });

  /** An action taking nothing SAYS so, so a caller can offer it as a plain button. */
  it("states an empty argument list for an action that takes none", () => {
    const lock = describeAll(allParams()).find((d) => d.capability === "lock")!;
    expect(lock.actions.find((a) => a.name === "lock")!.args).toEqual([]);
  });

  it("describes a provider-gated method only on a device bound to that provider", () => {
    const withoutMedia = describeAll(allParams()).find((d) => d.capability === "camera")!;
    const withMedia = describeAll(allParams(), {} as MediaProvider).find((d) => d.capability === "camera")!;
    const named = (d: typeof withMedia): string[] => [...d.actions.map((a) => a.name), ...d.undescribedActions];
    expect(named(withoutMedia)).not.toContain("snapshot");
    expect(named(withMedia)).toContain("snapshot");
  });
});

describe("Device.describe — the manifest a caller renders from", () => {
  const record = { deviceType: 30, model: "T8410", category: "eufy_security", params: { 1101: "88", 1102: "1" } };
  const bound = (): Device => {
    const dev = Device.fromRecord("T8000P0000000000", record);
    dev.bindActions(ctxWith(new Set([1101, 1102])), sink);
    return dev;
  };

  it("says a device is unbound rather than describing it as exposing nothing", () => {
    const dev = Device.fromRecord("T8000P0000000000", record);
    const m = dev.describe();
    expect(m.bound).toBe(false);
    expect(m.details).toEqual([]);
    expect(m.capabilities).toEqual(dev.capabilities);
    expect(m).toMatchObject({ sn: "T8000P0000000000", codec: "camera", source: "model" });
  });

  it("describes what the device installed once it is bound", () => {
    const m = bound().describe();
    expect(m.bound).toBe(true);
    const battery = m.details.find((d) => d.capability === "battery")!;
    expect(battery.reads.map((r) => r.accessor)).toContain("level");
  });

  it("carries shape only — no observed value reaches the manifest", () => {
    const dev = bound();
    const leaked: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (!v || typeof v !== "object") return;
      for (const [k, child] of Object.entries(v)) {
        if (k === "value" || k === "ts") leaked.push(`${path}.${k}`);
        walk(child, `${path}.${k}`);
      }
    };
    walk(dev.describe(), "manifest");
    expect(leaked).toEqual([]);
    expect(JSON.stringify(dev.describe())).not.toContain("88");
  });

  /**
   * A getter that throws is the only unfalsifiable proof: a `decode` read calls into the injected codec,
   * so spreading or stringifying a bound object here would reach the transport through it.
   */
  it("invokes no getter while describing", () => {
    const battery = {};
    Object.defineProperty(battery, "level", {
      get: () => {
        throw new Error("getter invoked");
      },
      enumerable: true,
      configurable: true,
    });
    const described = describeCapabilities({ battery } as never);
    expect(described.find((d) => d.capability === "battery")!.reads.map((r) => r.accessor)).toEqual(["level"]);
  });

  it("survives the round-trip a host consumes it over", () => {
    const m = bound().describe();
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it("describes every capability the device bound, and none it lacks", () => {
    const dev = bound();
    const m = dev.describe();
    const described = new Set<Capability>(m.details.map((d) => d.capability));
    for (const cap of described) expect(dev.has(cap)).toBe(true);
    expect(m.details.every((d) => (dev as unknown as Record<string, () => unknown>)[d.accessor]())).toBe(true);
  });
});

/** A command never leaves the manifest path — describing a device is a read of its shape. */
describe("describing a device sends nothing", () => {
  it("dispatches no command", () => {
    const sent: Command[] = [];
    const dev = Device.fromRecord("T8000P0000000000", { deviceType: 30, model: "T8410", params: { 1101: "88" } });
    dev.bindActions(ctxWith(allParams()), { dispatch: async (c) => void sent.push(c) });
    dev.describe();
    expect(sent).toEqual([]);
  });
});
