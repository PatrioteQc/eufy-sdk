import { describe, expect, it } from "vitest";
import { PushClient } from "../push-client.js";

describe("push availability evidence", () => {
  it("does not interpret the unverified m field as device, station, or transport availability", () => {
    const client = new PushClient({
      fid: "synthetic-fid",
      androidId: "1",
      securityToken: "2",
      fcmToken: "synthetic-token",
      createdAt: 0,
    });
    const event = (client as any).normalize({
      payload: {
        device_sn: "T8000P0000000000",
        station_sn: "T8000P0000000001",
        m: 0,
      },
    });

    expect(event.payload.m).toBe(0);
    expect(event).not.toHaveProperty("availability");
    expect(event).not.toHaveProperty("scope");
  });
});
