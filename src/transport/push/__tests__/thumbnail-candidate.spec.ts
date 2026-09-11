import { normalizePushEvent } from "../push-client.js";

describe("push thumbnail attribution", () => {
  it("attributes a thumbnail candidate to an exact nested device claim", () => {
    const event = normalizePushEvent({
      payload: {
        payload: {
          device_sn: "T8000P0000000000",
          pic_url: "https://example.test/thumbnail.jpg",
        },
      },
    });

    expect(event.thumbnailCandidate).toEqual({
      url: "https://example.test/thumbnail.jpg",
      attribution: { kind: "device", deviceSn: "T8000P0000000000" },
    });
  });

  it("attributes matching nested and envelope claims to the exact device", () => {
    const event = normalizePushEvent({
      payload: {
        device_sn: "T8000P0000000000",
        payload: {
          device_sn: "T8000P0000000000",
          thumbnail: "https://example.test/thumbnail.jpg",
        },
      },
    });

    expect(event.thumbnailCandidate?.attribution).toEqual({
      kind: "device",
      deviceSn: "T8000P0000000000",
    });
  });

  it("marks conflicting nested and envelope device claims as ambiguous", () => {
    const event = normalizePushEvent({
      payload: {
        device_sn: "T8000P0000000001",
        payload: {
          device_sn: "T8000P0000000000",
          pic_url: "https://example.test/thumbnail.jpg",
        },
      },
    });

    expect(event.thumbnailCandidate?.attribution).toEqual({ kind: "ambiguous" });
  });

  it("attributes short s identity evidence only to a station", () => {
    const event = normalizePushEvent({
      payload: {
        payload: {
          s: "T8000P0000000000",
          pic_url: "https://example.test/thumbnail.jpg",
        },
      },
    });

    expect(event.thumbnailCandidate?.attribution).toEqual({
      kind: "station",
      stationSn: "T8000P0000000000",
    });
  });

  it("attributes station_sn identity evidence only to a station", () => {
    const event = normalizePushEvent({
      payload: {
        station_sn: "T8000P0000000000",
        payload: { thumbnail: "https://example.test/thumbnail.jpg" },
      },
    });

    expect(event.thumbnailCandidate?.attribution).toEqual({
      kind: "station",
      stationSn: "T8000P0000000000",
    });
  });

  it("marks a thumbnail candidate without identity claims as ambiguous", () => {
    const event = normalizePushEvent({
      payload: {
        payload: { pic_url: "https://example.test/thumbnail.jpg" },
      },
    });

    expect(event.thumbnailCandidate?.attribution).toEqual({ kind: "ambiguous" });
  });

  it("does not construct a candidate from malformed or empty URL fields", () => {
    const event = normalizePushEvent({
      payload: {
        payload: {
          device_sn: "T8000P0000000000",
          pic_url: 42 as never,
          thumbnail: "   ",
        },
      },
    });

    expect(event.thumbnailCandidate).toBeUndefined();
  });
});
