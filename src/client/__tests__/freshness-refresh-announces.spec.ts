import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * The read-through freshness refresh as an INBOUND PATH.
 *
 * `getDevice` wires a policy that fires a background cloud re-read when a property is read while stale,
 * and hands the triggering read the stale value. That refresh is, for a host that reads often, the path
 * most fresh cloud values actually arrive on — it fires roughly every `cacheTtlMs`, where the poll fires
 * every ten minutes. So a change it lands is a change the poll will never see afterwards, because live
 * state has already caught up and the poll's own diff is edge-triggered on live state.
 *
 * Leaving it silent therefore does not defer the announcement, it LOSES it: the host is left holding the
 * previous value with nothing telling it to look again, which is the complaint the announcement exists to
 * answer. So this path announces too. Its timing says only when a caller happened to read, which is
 * exactly what the announcement's own docs state about latency — but the VALUE is news either way, and no
 * spurious event is possible, because the announcement is edge-triggered.
 *
 * It also has to apply what the device volunteered over realtime, not only the cloud record's params.
 * The two are kept apart in the registry, so applying the cloud half alone reverts live state for any id
 * a report made fresher — and once the path announces, it would announce that revert.
 */
function withFreshnessPolicy() {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", cacheTtlMs: 1000 });
  const record: { params: Record<number, string>; dpParams?: Record<number, string> } & Record<string, unknown> = {
    model: "T8900",
    category: "eufy_security",
    params: { 1550: "0", 1141: "-70" },
    paramUpdatedAt: {},
  };
  vi.spyOn((eufy as any).registry, "record").mockImplementation(async () => record);
  vi.spyOn(eufy as any, "commandContext").mockResolvedValue({ channel: 0, codec: "sensor", paramIds: new Set([1550]) });
  vi.spyOn(eufy as any, "commandSinkFor").mockReturnValue({ dispatch: async () => undefined });
  vi.spyOn(eufy as any, "mediaProviderFor").mockReturnValue(undefined);
  vi.spyOn(eufy as any, "awaitFirstRealtimeState").mockResolvedValue(undefined);
  vi.spyOn((eufy as any).registry, "applyRealtimeParams").mockImplementation(() => {});
  const seen: any[] = [];
  eufy.on("propertyChanged", (e) => seen.push(e));
  return { eufy, record, seen };
}

/** Age every stored value past the staleness window without waiting for it. */
const makeStale = (dev: unknown) => {
  for (const v of (dev as { state: Map<string, { ts: number }> }).state.values()) v.ts -= 10_000;
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the read-through freshness refresh announces what it lands", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("announces a value the background re-read brought in", async () => {
    const { eufy, record, seen } = withFreshnessPolicy();
    const dev = await eufy.getDevice("T8000P0000000000");
    expect(dev.getProperty("contact")?.value).toBe(false);

    record.params = { ...record.params, 1550: "1" };
    makeStale(dev);
    dev.getProperty("contact"); // a stale read fires the refresh and is handed the stale value
    await settle();

    expect(seen).toEqual([{ deviceSn: "T8000P0000000000", property: "contact", value: true }]);
    expect(dev.getProperty("contact")?.value).toBe(true);
  });

  it("says nothing when the re-read brought in the same values", async () => {
    const { eufy, seen } = withFreshnessPolicy();
    const dev = await eufy.getDevice("T8000P0000000000");

    makeStale(dev);
    dev.getProperty("contact");
    await settle();

    expect(seen).toEqual([]);
  });

  /**
   * The registry keeps a device's realtime report apart from the cloud record's params, so the cloud half
   * still carries the pre-report value. Applying it alone would revert live state and announce the revert.
   */
  it("does not revert or announce a revert of what a realtime report landed", async () => {
    const { eufy, record, seen } = withFreshnessPolicy();
    const dev = await eufy.getDevice("T8000P0000000000");
    (eufy as any).applyRealtimeState("T8000P0000000000", { 1550: "1" });
    expect(seen).toEqual([{ deviceSn: "T8000P0000000000", property: "contact", value: true }]);
    record.dpParams = { 1550: "1" }; // the registry answers with the report beside the stale cloud half

    makeStale(dev);
    dev.getProperty("contact");
    await settle();

    expect(dev.getProperty("contact")?.value).toBe(true);
    expect(seen).toHaveLength(1); // the realtime announcement, and no revert after it
  });
});
