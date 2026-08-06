import { describe, it, expect } from "vitest";
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
});
