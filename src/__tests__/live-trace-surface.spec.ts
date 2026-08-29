import { describe, expect, it } from "vitest";
import { LIVE_TRACE_MESSAGE, type LiveTrace } from "../index.js";

/**
 * The live-trace vocabulary is reachable from the package entry point.
 *
 * `live-trace.ts` instructs a caller to match on the message plus a phase to tell one startup outcome
 * from another, and it reaches the root through three `export *` hops. Nothing pinned that, and a
 * consumer concluded from the entry point's declaration file — which contains four `export *` lines and
 * therefore greps zero for every symbol in the package — that the vocabulary was unreachable, and
 * hand-copied the message literal and all eleven phases instead.
 *
 * A hand-copied phase list is the one thing that cannot survive the union widening: the SDK adds a phase
 * without needing consumer coordination, and a list not typed against the union compiles and passes its
 * own tests while silently discarding the new one. That happened once already, to `sequence-restart`.
 *
 * Imported through `../index.js` deliberately, so removing the barrel hop breaks this rather than only
 * breaking a consumer after release.
 */
describe("live-trace vocabulary at the package entry point", () => {
  it("publishes the message a caller matches traces on", () => {
    expect(LIVE_TRACE_MESSAGE).toBe("[live] start trace");
  });

  it("publishes a phase union a caller can exhaust, so a new phase fails to compile", () => {
    const handled = {
      "media-command": true,
      "media-command-ack": true,
      "media-command-retry": true,
      "media-command-unacknowledged": true,
      "first-video-command": true,
      "first-video-unit": true,
      "first-keyframe": true,
      "first-foreign-media-command": true,
      "video-decode-empty": true,
      "datagram-gap": true,
      "sequence-restart": true,
    } satisfies Record<LiveTrace["phase"], true>;
    // The `satisfies` is the assertion; `tsc` covers the specs, so a phase added or removed fails there. This
    // names the phase whose omission from a consumer's hand-copied list is what #99 was filed over.
    expect(Object.keys(handled)).toContain("sequence-restart");
  });
});
