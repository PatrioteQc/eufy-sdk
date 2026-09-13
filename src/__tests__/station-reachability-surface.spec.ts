import { describe, expect, it } from "vitest";
import { P2P_STATION_WAITS, StationUnreachableError } from "../index.js";

describe("station reachability at the package entry point", () => {
  it("publishes the waits a caller places its own bound above", () => {
    expect(P2P_STATION_WAITS.connect).toBeGreaterThan(0);
    expect(P2P_STATION_WAITS.level2Grace).toBeGreaterThan(0);
    expect(P2P_STATION_WAITS.level2Settle).toBeGreaterThan(0);
  });

  it("publishes the refusal a caller narrows on", () => {
    const error = new StationUnreachableError(20_000);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StationUnreachableError");
    expect(error.retryable).toBe(true);
    expect(error.waitedMs).toBe(20_000);
  });
});
