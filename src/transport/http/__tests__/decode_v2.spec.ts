import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decode as jpegDecode } from "jpeg-js";
import { autoContrast, decodeImageV2, isV2Image } from "../decodeImageV2.js";
import { normalizePushImage } from "../decodeImageV1.js";

/** Both fixtures are FULLY SYNTHETIC (no captured device data / real serials). Regenerate with `scripts/dev/gen_v2_fixture.py <w> <h> <out.b64>`. */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => Buffer.from(readFileSync(join(FIXTURE_DIR, name), "utf-8"), "base64");
const v2Blob = readFixture("v2_thumbnail_176x144.b64");
/** Synthetic non-ladder geometry (264×200 is not on the search's coarse ladder). */
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
    expect(isV2Image(Buffer.from("v2_eufysecurityX:garbage"))).toBe(false);
  });

  it("reconstructs a decodable JPEG at the original geometry", () => {
    const jpeg = decodeImageV2(v2Blob);
    expect(jpeg).not.toBeNull();
    expect(jpeg!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegSize(jpeg!)).toEqual({ width: 176, height: 144 });
  });

  it("recovers an off-ladder geometry from a synthetic blob (264×200)", () => {
    const jpeg = decodeImageV2(v2Blob264);
    expect(jpeg).not.toBeNull();
    expect(jpeg!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpeg!.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
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
        expect(min).toBeLessThanOrEqual(2);
        expect(max).toBeGreaterThanOrEqual(253);
        expect(sum / n).toBeCloseTo(means[c], 0);
      }
    });
  }
});

describe("autoContrast (PIL ImageOps.autocontrast parity, cutoff 0.5%)", () => {
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
    expect(channelSum(data, 0, N)).toBe(50090);
    expect(channelSum(data, 1, N)).toBe(50907);
    expect(channelSum(data, 2, N)).toBe(50788);
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
