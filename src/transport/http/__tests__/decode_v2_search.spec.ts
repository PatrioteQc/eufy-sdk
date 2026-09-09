import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The geometry search's COST, which the reconstruction specs cannot see.
 *
 * Those specs check that the right image comes out, and would still pass if the search reached that
 * answer by decoding every frame on the ladder. It once did, and the bill was the whole of this
 * module's footprint: recovering a 176×144 thumbnail meant 98 candidate decodes totalling 29.7 Mpx,
 * of which 29.2 Mpx belonged to candidates that then threw — three of them at 1920×1080. A decoder
 * allocates a candidate's component buffers before it can discover the scan does not fill it, so
 * those doomed attempts were ~150 MB of resident memory and ~1.5 s of blocked event loop per push
 * thumbnail.
 *
 * Counting decoder calls rather than timing the run: the property is "the search does not attempt
 * frames it can prove are too large", which is exact, and a stopwatch on a shared CI host is not.
 */
vi.mock("jpeg-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jpeg-js")>();
  return { ...actual, decode: vi.fn(actual.decode) };
});

const { decode } = await import("jpeg-js");
const { decodeImageV2 } = await import("../decodeImageV2.js");

/** Both fixtures are FULLY SYNTHETIC (no captured device data / real serials). */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => Buffer.from(readFileSync(join(FIXTURE_DIR, name), "utf-8"), "base64");

/** The frame geometry a spliced candidate declares, read back out of its SOF0. */
function candidateFrames(): { width: number; height: number }[] {
  return vi.mocked(decode).mock.calls.map(([data]) => {
    const jpeg = Buffer.from(data as Uint8Array);
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    return { height: (jpeg[sof + 5]! << 8) | jpeg[sof + 6]!, width: (jpeg[sof + 7]! << 8) | jpeg[sof + 8]! };
  });
}

describe("v2 geometry search cost", () => {
  it.each(["v2_thumbnail_176x144.b64", "v2_thumbnail_264x200.b64"])(
    "stops climbing the ladder once a frame fails (%s)",
    (fixture) => {
      expect(decodeImageV2(readFixture(fixture))).not.toBeNull();

      const frames = candidateFrames();
      const megapixels = frames.reduce((sum, f) => sum + f.width * f.height, 0) / 1e6;
      const largest = frames.reduce((max, f) => Math.max(max, f.width * f.height), 0);

      // An order of magnitude below the unbounded walk rather than pinned to today's exact figures,
      // so this fails when the search starts trying everything again and not when a ladder rung is
      // added. Measured on these fixtures: 26 and 38 decodes, 0.68 and 1.69 Mpx, largest 320x180.
      expect(frames.length).toBeLessThan(60);
      expect(megapixels).toBeLessThan(5);
      expect(largest).toBeLessThan(1_000_000);
    },
  );
});
