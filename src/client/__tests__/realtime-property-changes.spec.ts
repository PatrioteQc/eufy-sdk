import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";
import { VACUUM_DP } from "../../model/capabilities/vacuum-clean.js";

/**
 * `propertyChanged` on the REALTIME half — a P2P frame, a secure-MQTT report, or a Tuya data point.
 *
 * Three of the four inbound paths for the security line come through `applyRealtimeState`, and it is
 * also the only inbound path the clean and life lines have: a robot's cloud record carries none of its
 * data points, so before this the entire clean line announced nothing at all beyond `deviceState`.
 *
 * The edge is free here — `applyParams` reports only the properties whose value actually moved — so a
 * device that re-reports the same state repeatedly is silent, without a dedupe table.
 */
function withLiveDevice(sn: string, record: Parameters<typeof Device.fromRecord>[1]) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  const dev = Device.fromRecord(sn, record);
  (eufy as never as { liveDevices: Map<string, WeakRef<Device>> }).liveDevices.set(sn, new WeakRef(dev));
  // The evidence is already what the record reported, so a report of the same ids does not widen it and
  // no re-bind (a cloud round-trip) is triggered — that path has its own specs.
  (eufy as never as { boundParamIds: Map<string, ReadonlySet<number>> }).boundParamIds.set(
    sn,
    new Set(Object.keys(record.params ?? {}).map(Number)),
  );
  vi.spyOn((eufy as never as { registry: { applyRealtimeParams: () => void } }).registry, "applyRealtimeParams");
  const seen: unknown[] = [];
  eufy.on("propertyChanged", (e) => seen.push(e));
  const report = (params: Record<number, string>) =>
    (eufy as never as { applyRealtimeState: (s: string, p: Record<number, string>) => void }).applyRealtimeState(
      sn,
      params,
    );
  return { eufy, dev, seen, report };
}

const SENSOR = "T8000P0000000000";
const ROBOT = "T8000P0000000001";

describe("propertyChanged from a realtime report", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("announces what a station's volunteered params moved", () => {
    const { seen, dev, report } = withLiveDevice(SENSOR, {
      model: "T8900",
      category: "eufy_security",
      params: { 1550: "0" },
    });

    report({ 1550: "1" });

    expect(seen).toEqual([{ deviceSn: SENSOR, property: "contact", value: true }]);
    expect(dev.getProperty("contact")?.value).toBe(true);
  });

  /** A report repeating the current state is not a change, so there is nothing to announce. */
  it("says nothing for a report that repeats the current state", () => {
    const { seen, report } = withLiveDevice(SENSOR, {
      model: "T8900",
      category: "eufy_security",
      params: { 1550: "1" },
    });

    report({ 1550: "1" });

    expect(seen).toEqual([]);
  });

  /**
   * The announcement lands before `deviceState`, so a host reacting to either sees the same state, and the
   * more specific fact arrives first.
   */
  it("announces the change before the liveness event", () => {
    const { eufy, seen, report } = withLiveDevice(SENSOR, {
      model: "T8900",
      category: "eufy_security",
      params: { 1550: "0" },
    });
    const order: string[] = [];
    eufy.on("propertyChanged", () => order.push("propertyChanged"));
    eufy.on("deviceState", () => order.push("deviceState"));

    report({ 1550: "1" });

    expect(order).toEqual(["propertyChanged", "deviceState"]);
    expect(seen).toHaveLength(1);
  });

  /** The opt-out is the member's own, so it holds on this path exactly as it does on the poll. */
  it("respects a member that opted out of announcing", () => {
    const { seen, dev, report } = withLiveDevice(SENSOR, {
      model: "T8900",
      category: "eufy_security",
      params: { 1550: "0", 1551: "1000" },
    });

    report({ 1551: "2000" });

    expect(seen).toEqual([]);
    expect(dev.getProperty("lastSeen")?.value).toBe(2000); // still applied and still readable
  });

  /**
   * The clean line reaches its state only this way, and its monotonic counters advance for the whole
   * duration of a run — so they are applied and readable but never announced, the same call
   * `contact.lastSeen` makes for the same reason.
   */
  it("announces a robot's activity and not its lifetime counters", () => {
    const { seen, report } = withLiveDevice(ROBOT, {
      model: "T2351",
      params: { [VACUUM_DP.WORK_STATUS]: "AAAA", [VACUUM_DP.CLEAN_STATS]: "AAAA" },
    });

    report({ [VACUUM_DP.WORK_STATUS]: "BBBB", [VACUUM_DP.CLEAN_STATS]: "BBBB" });

    // `activity` stores a protobuf payload, so it is named with no value — "this moved, re-read it".
    expect(seen).toEqual([{ deviceSn: ROBOT, property: "activity" }]);
  });
});
