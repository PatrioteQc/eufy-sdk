import { freshestLanIp } from "../index.js";

// Fixtures mirror the SHAPE of records observed live on the lab fleet — IPs are synthetic but stay
// within RFC-1918 private ranges (docs/REDACTION.md: RFC-5737 doc-range would fail isPrivateIpv4).
describe("freshestLanIp — newest heartbeat wins over stale top-level fields", () => {
  it("prefers a private-IP param over a stale pairing ip_addr (SoloCam T8170)", () => {
    // ip_addr froze at pairing on the old subnet; param 1176 was heartbeated later on the new one.
    const rec = {
      ip_addr: "192.168.55.167",
      local_ip: "",
      params: [
        { param_type: 1419, param_value: "", update_time: 1712861576 },
        { param_type: 1176, param_value: "192.168.99.76", update_time: 1741285029 },
      ],
    };
    expect(freshestLanIp(rec)).toBe("192.168.99.76");
  });

  it("filters out a public WAN ip_addr, using the LAN heartbeat param (HomeBase)", () => {
    const rec = {
      ip_addr: "203.0.113.128", // public WAN — must never be returned
      params: [{ param_type: 1176, param_value: "192.168.99.73", update_time: 1782948594 }],
    };
    expect(freshestLanIp(rec)).toBe("192.168.99.73");
  });

  it("takes the newest of several IP params by update_time", () => {
    const rec = {
      params: [
        { param_type: 1176, param_value: "192.168.99.10", update_time: 100 },
        { param_type: 1176, param_value: "192.168.99.20", update_time: 999 },
        { param_type: 1176, param_value: "192.168.99.15", update_time: 500 },
      ],
    };
    expect(freshestLanIp(rec)).toBe("192.168.99.20");
  });

  it("does NOT mistake a version string (e.g. 0.0.0.3) for an IP", () => {
    const rec = {
      ip_addr: "192.168.99.70",
      params: [{ param_type: 1074, param_value: "0.0.0.3", update_time: 9999 }],
    };
    // 0.0.0.3 is not RFC-1918 → ignored; falls back to the valid private ip_addr.
    expect(freshestLanIp(rec)).toBe("192.168.99.70");
  });

  it("falls back to ip_addr when no param carries a private IP (wired Indoor cams)", () => {
    const rec = { ip_addr: "192.168.99.79", params: [{ param_type: 6040, param_value: "1", update_time: 1 }] };
    expect(freshestLanIp(rec)).toBe("192.168.99.79");
  });

  it("returns undefined when nothing usable is present", () => {
    expect(freshestLanIp({ ip_addr: "", local_ip: "", params: [] })).toBeUndefined();
    expect(freshestLanIp({})).toBeUndefined();
    expect(freshestLanIp(undefined)).toBeUndefined();
  });
});

describe("reportedRtspUrl — a device-volunteered rtsp:// URL mined from the record's params", () => {
  it("extracts a bare rtsp URL param and prefers the newest", async () => {
    const { reportedRtspUrl } = await import("../index.js");
    const rec = {
      params: [
        { param_type: 1146, param_value: "rtsp://192.168.99.10:554/live0", update_time: 100 },
        { param_type: 1146, param_value: "rtsp://192.168.99.10:554/live1", update_time: 200 },
      ],
    };
    expect(reportedRtspUrl(rec)).toBe("rtsp://192.168.99.10:554/live1");
  });

  it("digs a URL out of a JSON-encoded param value without dragging quotes along", async () => {
    const { reportedRtspUrl } = await import("../index.js");
    const rec = {
      params: [{ param_type: 1147, param_value: '{"url":"rtsp://192.168.99.10/live0","on":1}', update_time: 5 }],
    };
    expect(reportedRtspUrl(rec)).toBe("rtsp://192.168.99.10/live0");
  });

  it("returns undefined when no param carries one", async () => {
    const { reportedRtspUrl } = await import("../index.js");
    expect(reportedRtspUrl({ params: [{ param_type: 1176, param_value: "192.168.99.10" }] })).toBeUndefined();
    expect(reportedRtspUrl(undefined)).toBeUndefined();
  });
});

describe("reportedRtspUrl — the registry's merged DeviceRecord shape", () => {
  it("reads params as id → value with paramUpdatedAt beside it, newest wins", async () => {
    const { reportedRtspUrl } = await import("../index.js");
    const rec = {
      params: {
        1146: "rtsp://olduser:oldpass@192.168.99.10/live0",
        1147: "rtsp://newuser:newpass@192.168.99.10/live0",
      },
      paramUpdatedAt: { 1146: 100, 1147: 200 },
    };
    expect(reportedRtspUrl(rec)).toBe("rtsp://newuser:newpass@192.168.99.10/live0");
  });

  it("prefers the realtime dpParams report over any cloud param", async () => {
    const { reportedRtspUrl } = await import("../index.js");
    const rec = {
      params: { 1146: "rtsp://olduser:oldpass@192.168.99.10/live0" },
      paramUpdatedAt: { 1146: 999_999 },
      dpParams: { 1146: "rtsp://liveuser:livepass@192.168.99.10/live0" },
    };
    expect(reportedRtspUrl(rec)).toBe("rtsp://liveuser:livepass@192.168.99.10/live0");
  });
});
