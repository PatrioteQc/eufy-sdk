import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decode as jpegDecode } from "jpeg-js";
import { autoContrast, decodeImageV2, isV2Image } from "../decodeImageV2.js";
import { normalizePushImage } from "../decodeImageV1.js";

// Both fixtures are FULLY SYNTHETIC (no captured device data / real serials): the ascii
// `v2_eufysecurity:` wrapper + a synthetic serial + a standard baseline 4:4:4 JPEG, whose plaintext
// tail from `FF C4 00 1F 01` is exactly what a real v2 blob leaves in the clear. Regenerate with
// `scripts/dev/gen_v2_fixture.py <w> <h> <out.b64>`.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => Buffer.from(readFileSync(join(FIXTURE_DIR, name), "utf-8"), "base64");
const v2Blob = readFixture("v2_thumbnail_176x144.b64");
// A synthetic non-ladder geometry (264×200 is not on the search's coarse ladder), to prove the
// width/height search recovers an arbitrary size.
const v2Blob264 = readFixture("v2_thumbnail_264x200.b64");

/** Read a baseline JPEG's SOF0 dimensions, to check the reconstructed geometry. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  return { height: (jpeg[sof + 5] << 8) | jpeg[sof + 6], width: (jpeg[sof + 7] << 8) | jpeg[sof + 8] };
}

/** Sum of one RGBA channel over `count` pixels. */
function channelSum(data: Uint8Array, channel: number, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += data[i * 4 + channel];
  return sum;
}

describe("decodeImageV2 (keyless v2_eufysecurity)", () => {
  it("recognises a v2 blob and rejects v1/other/near-miss prefixes", () => {
    expect(isV2Image(v2Blob)).toBe(true);
    expect(isV2Image(Buffer.from("eufysecurity:T8:CODE:xxxx"))).toBe(false);
    expect(isV2Image(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    // The prefix match includes the trailing colon, so a longer look-alike token is NOT a v2 blob.
    expect(isV2Image(Buffer.from("v2_eufysecurityX:garbage"))).toBe(false);
  });

  it("reconstructs a decodable JPEG at the original geometry", () => {
    const jpeg = decodeImageV2(v2Blob);
    expect(jpeg).not.toBeNull();
    expect(jpeg!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // SOI — a real JPEG
    // Geometry recovered by the search (width refined, height pinned to the scan's fill).
    expect(jpegSize(jpeg!)).toEqual({ width: 176, height: 144 });
  });

  it("recovers an off-ladder geometry from a synthetic blob (264×200)", () => {
    const jpeg = decodeImageV2(v2Blob264);
    expect(jpeg).not.toBeNull();
    expect(jpeg!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpeg!.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9])); // EOI — a complete JPEG
    expect(jpegSize(jpeg!)).toEqual({ width: 264, height: 200 });
  });

  it("returns null for a non-v2 blob", () => {
    expect(decodeImageV2(Buffer.from("not a v2 image"))).toBeNull();
  });

  it("normalizePushImage routes a v2 blob through the decoder", () => {
    const out = normalizePushImage(v2Blob);
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegSize(out)).toEqual({ width: 176, height: 144 });
  });

  it("normalizePushImage leaves non-wrapped media unchanged", () => {
    const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(normalizePushImage(plain)).toBe(plain);
  });
});

describe("decodeImageV2 end-to-end de-fog (full decode → re-encode path)", () => {
  // The complete pipeline (geometry search → decode → autoContrast → JPEG re-encode) is
  // deterministic, so we decode the *emitted* JPEG and assert the de-fog survived the round-trip:
  // every channel is stretched across the full 0..255 range, and the per-channel mean matches the
  // reference produced by this exact pipeline (jpeg-js 0.4.x encode is deterministic). This covers the
  // whole path, not autoContrast in isolation — remove the de-fog step and these assertions fail.
  const cases = [
    { file: "v2_thumbnail_176x144.b64", width: 176, height: 144, means: [126.45, 128.36, 127.3] },
    { file: "v2_thumbnail_264x200.b64", width: 264, height: 200, means: [147.2, 124.59, 125.06] },
  ];
  for (const { file, width, height, means } of cases) {
    it(`stretches ${file} to full dynamic range through encode+decode`, () => {
      const out = decodeImageV2(readFixture(file));
      expect(out).not.toBeNull();
      const img = jpegDecode(out!, { useTArray: true });
      expect({ width: img.width, height: img.height }).toEqual({ width, height });
      const n = width * height;
      for (let c = 0; c < 3; c++) {
        let min = 255;
        let max = 0;
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const v = img.data[i * 4 + c];
          min = Math.min(min, v);
          max = Math.max(max, v);
          sum += v;
        }
        // De-fog stretched this channel across (near) the full range, end-to-end.
        expect(min).toBeLessThanOrEqual(2);
        expect(max).toBeGreaterThanOrEqual(253);
        // Deterministic pipeline mean, within lossy re-encode tolerance.
        expect(sum / n).toBeCloseTo(means[c], 0);
      }
    });
  }
});

describe("autoContrast (PIL ImageOps.autocontrast parity, cutoff 0.5%)", () => {
  // A deterministic 20×20 RGBA buffer (400 px → the cutoff trims 2 samples/end, so the trimming path
  // is exercised, not just a plain min/max stretch). Per-channel ramps plus a few outliers.
  const W = 20;
  const H = 20;
  const N = W * H;

  function buildInput(): Uint8Array {
    const data = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
      data[i * 4 + 0] = 40 + (i % 41);
      data[i * 4 + 1] = 100 + ((i * 7) % 30);
      data[i * 4 + 2] = (i * 13) % 200;
      data[i * 4 + 3] = 255;
    }
    // Outliers so the 0.5% cutoff has something to trim off each end.
    data[0] = 5;
    data[4] = 250;
    data[1] = 2;
    data[5] = 254;
    data[2] = 1;
    data[6] = 255;
    return data;
  }

  it("matches PIL's per-channel output statistics exactly", () => {
    const data = buildInput();
    autoContrast(data, W, H);
    // Reference values computed by Pillow 10 ImageOps.autocontrast(cutoff=0.5) on the same buffer.
    expect(channelSum(data, 0, N)).toBe(50090); // R
    expect(channelSum(data, 1, N)).toBe(50907); // G
    expect(channelSum(data, 2, N)).toBe(50788); // B
    // The stretch reaches full black/white on every channel.
    for (let c = 0; c < 3; c++) {
      let min = 255;
      let max = 0;
      for (let i = 0; i < N; i++) {
        min = Math.min(min, data[i * 4 + c]);
        max = Math.max(max, data[i * 4 + c]);
      }
      expect(min).toBe(0);
      expect(max).toBe(255);
    }
  });

  it("matches PIL at specific pixels (int-truncation, not rounding)", () => {
    const data = buildInput();
    autoContrast(data, W, H);
    const px = (i: number) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    expect(px(0)).toEqual([0, 0, 0]);
    expect(px(10)).toEqual([63, 87, 166]);
    expect(px(199)).toEqual([223, 114, 239]);
  });
});
