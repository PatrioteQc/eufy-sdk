import { describe, it, expect, vi } from "vitest";
import { commandObservation, observeCommand } from "../../core/contracts.js";
import { EufyMega } from "../eufy-mega.js";
import type { AnyDeviceEvent } from "../types.js";

/**
 * The catch-all `"event"` listener's tag key.
 *
 * The tag is `eventName`, not `name`, because a semantic payload can legitimately carry its own `name`
 * — a device name arrives that way on the wire — and tagging over it would destroy data the caller
 * needs. These specs pin the key in both directions: the runtime shape, and that the same key is the
 * compile-time discriminant of {@link AnyDeviceEvent}. Asserting only one of the two is what lets the
 * declared tag and the emitted one drift apart.
 */
describe("catch-all event tag", () => {
  const client = () => new EufyMega({ email: "t@example.com", password: "x" });

  it("tags the payload with eventName", async () => {
    const eufy = client();
    const seen: AnyDeviceEvent[] = [];
    eufy.on("event", (e) => seen.push(e));

    (eufy as any).emitSemantic("motion", { deviceSn: "T8000P0000000000" });

    expect(seen).toHaveLength(1);
    expect(seen[0].eventName).toBe("motion");
  });

  /**
   * A compile-time check as much as a runtime one: this only builds if `eventName` is the union's
   * discriminant, and `ptzNotify`'s `kind` is only reachable once narrowing has happened.
   */
  it("narrows the union on eventName", () => {
    const eufy = client();
    let narrowed: string | undefined;
    eufy.on("event", (e) => {
      if (e.eventName === "ptzNotify") narrowed = e.kind;
    });

    (eufy as any).emitSemantic("ptzNotify", { stationSn: "T8000P0000000000", kind: "rotate" });

    expect(narrowed).toBe("rotate");
  });

  /** The reason for the key choice: a push payload carries the device's own name in a `name` field. */
  it("does not clobber a payload's own `name` field", () => {
    const eufy = client();
    const seen: any[] = [];
    eufy.on("event", (e) => seen.push(e));

    (eufy as any).emitSemantic("motion", { deviceSn: "T8000P0000000000", name: "Camera A" });

    expect(seen[0].name).toBe("Camera A");
    expect(seen[0].eventName).toBe("motion");
  });

  /** Tagging is the catch-all's concern; a per-name listener gets the payload as the capability built it. */
  it("still delivers to the per-name listener untagged", () => {
    const eufy = client();
    const seen: any[] = [];
    eufy.on("motion", (e) => seen.push(e));

    (eufy as any).emitSemantic("motion", { deviceSn: "T8000P0000000000" });

    expect(seen).toHaveLength(1);
    expect(seen[0].eventName).toBeUndefined();
  });

  it("refreshes retained device state before emitting an event that requires a re-read", async () => {
    const eufy = client();
    const sequence: string[] = [];
    let mode = 1;
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: vi.fn((params: Record<number, string>) => {
        mode = Number(params[1224]);
        sequence.push("refresh");
      }),
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "63" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    eufy.on("armingModeChanged", () => sequence.push("event"));

    (eufy as any).emitSemantic(
      "armingModeChanged",
      { deviceSn: "T8000P0000000000" },
      { refresh: { param: 1224, property: "armingMode", timeoutMs: 20_000 } },
    );

    expect(sequence).toEqual([]);
    await vi.waitFor(() => expect(sequence).toEqual(["refresh", "event"]));
    expect(device.applyParams).toHaveBeenCalledExactlyOnceWith({ 1224: "63" });
  });

  it("applies a converged cloud record once after unchanged refresh attempts", async () => {
    vi.useFakeTimers();
    const eufy = client();
    let mode = 1;
    let cloudMode = "1";
    let polls = 0;
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: vi.fn((params: Record<number, string>) => {
        mode = Number(params[1224]);
      }),
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockImplementation(() => ({ params: { 1224: cloudMode } }));
    vi.spyOn((eufy as any).registry, "getDevices").mockImplementation(async () => {
      polls += 1;
      if (polls === 3) cloudMode = "63";
      return [];
    });
    const seen: number[] = [];
    eufy.on("armingModeChanged", () => seen.push(mode));

    (eufy as any).emitSemantic(
      "armingModeChanged",
      { deviceSn: "T8000P0000000000" },
      { refresh: { param: 1224, property: "armingMode", timeoutMs: 20_000 } },
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(seen).toEqual([63]);
    expect(device.applyParams).toHaveBeenCalledExactlyOnceWith({ 1224: "63" });
    vi.useRealTimers();
  });

  it("serializes consecutive valueless transitions so each event observes its own state", async () => {
    const eufy = client();
    let mode = 1;
    let cloudMode = "1";
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: (params: Record<number, string>) => {
        mode = Number(params[1224]);
      },
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockImplementation(() => ({ params: { 1224: cloudMode } }));
    vi.spyOn((eufy as any).registry, "getDevices").mockImplementation(async () => {
      cloudMode = cloudMode === "1" ? "63" : "1";
      return [];
    });
    const seen: number[] = [];
    eufy.on("armingModeChanged", () => seen.push(mode));
    const options = { refresh: { param: 1224, property: "armingMode", timeoutMs: 20_000 } };

    (eufy as any).emitSemantic("armingModeChanged", { deviceSn: "T8000P0000000000" }, options);
    (eufy as any).emitSemantic("armingModeChanged", { deviceSn: "T8000P0000000000" }, options);

    await vi.waitFor(() => expect(seen).toEqual([63, 1]));
  });

  it("refreshes and emits after an observed command even when no push event arrives", async () => {
    const eufy = client();
    let mode = 1;
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: (params: Record<number, string>) => {
        mode = Number(params[1224]);
      },
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "63" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    vi.spyOn(eufy as any, "routeCommand").mockResolvedValue(undefined);
    const reset = vi.spyOn((eufy as any).p2p, "resetStandaloneSession").mockResolvedValue(undefined);
    const seen: number[] = [];
    eufy.on("armingModeChanged", () => seen.push(mode));
    const command = observeCommand(
      { kind: "set-param", param: 1224, value: 63, form: "auto", channel: 0 },
      {
        event: "armingModeChanged",
        expected: 63,
        param: 1224,
        property: "armingMode",
        resetStandaloneSession: true,
        timeoutMs: 20_000,
      },
    );

    await (eufy as any).commandSinkFor("T8000P0000000000").dispatch(command);

    expect((eufy as any).routeCommand).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(seen).toEqual([63]));
    expect(reset).toHaveBeenCalledExactlyOnceWith("T8000P0000000000");
  });

  it("completes convergence and standalone reset before dispatching the next observed command", async () => {
    const eufy = client();
    let mode = 1;
    let cloudMode = "1";
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: (params: Record<number, string>) => {
        mode = Number(params[1224]);
      },
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockImplementation(() => ({ params: { 1224: cloudMode } }));
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    vi.spyOn(eufy as any, "routeCommand").mockImplementation(async (...args: unknown[]) => {
      cloudMode = String(commandObservation(args[1] as never)!.expected);
    });
    const reset = vi.spyOn((eufy as any).p2p, "resetStandaloneSession").mockResolvedValue(undefined);
    const seen: number[] = [];
    eufy.on("armingModeChanged", () => seen.push(mode));
    const command = (expected: number) =>
      observeCommand(
        { kind: "set-param", param: 1224, value: expected, form: "auto", channel: 0 },
        {
          event: "armingModeChanged",
          expected,
          param: 1224,
          property: "armingMode",
          resetStandaloneSession: true,
          timeoutMs: 20_000,
        },
      );
    const sink = (eufy as any).commandSinkFor("T8000P0000000000");

    const disarm = sink.dispatch(command(63));
    const home = sink.dispatch(command(1));
    await Promise.all([disarm, home]);

    await vi.waitFor(() => expect(seen).toEqual([63, 1]));
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("acknowledges an observed command without failing when authoritative readback expires", async () => {
    vi.useFakeTimers();
    const eufy = client();
    const device = { getProperty: () => ({ value: 1 }), applyParams: vi.fn() };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "1" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    vi.spyOn(eufy as any, "routeCommand").mockResolvedValue(undefined);
    const reportError = vi.spyOn(eufy as any, "reportError").mockImplementation(() => undefined);
    const command = observeCommand(
      { kind: "set-param", param: 1224, value: 63, form: "auto", channel: 0 },
      { event: "armingModeChanged", expected: 63, param: 1224, property: "armingMode", timeoutMs: 20_000 },
    );

    await expect((eufy as any).commandSinkFor("T8000P0000000000").dispatch(command)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(reportError).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("allows observation policy to be replaced on a reused command object", () => {
    const command = { kind: "set-param", param: 1224, value: 63, form: "auto", channel: 0 } as const;
    const first = { event: "armingModeChanged", expected: 63, param: 1224, property: "armingMode", timeoutMs: 1 };
    const second = { ...first, expected: 1 };

    observeCommand(command, first);
    expect(() => observeCommand(command, second)).not.toThrow();
    expect(commandObservation(command)).toEqual(second);
  });
});
