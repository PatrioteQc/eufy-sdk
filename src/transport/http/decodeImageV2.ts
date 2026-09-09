/**
 * V2 `v2_eufysecurity:` push-thumbnail decoder — keyless.
 *
 * The v2 format is NOT end-to-end encrypted and needs NO key: it is *head-only obfuscation*. Only a
 * fixed JPEG prefix (SOI + APP0 + the two quantization tables + the SOF dimensions + the luma Huffman
 * tables) is encrypted; everything from the standard DC-chrominance Huffman table (`FF C4 00 1F 01`)
 * onward — the chroma DHTs, the SOS and the entire entropy-coded scan — is left as plaintext standard
 * JPEG. So we reconstruct a viewable image by splicing a freshly built standard JPEG header (correct
 * width/height/chroma-subsampling) onto that plaintext tail.
 *
 * Three unknowns live in the encrypted prefix and are recovered by search:
 *   - chroma subsampling — a wrong guess speckles the chroma planes (highest colour spread);
 *   - width — a wrong width shears every row (highest row-to-row difference);
 *   - height — the number of MCU rows the scan fills.
 * The quant tables are lost too (a mild quality/colour shift), but the image is fully recognisable.
 *
 * `jpeg-js` throws on an under-filled frame (unlike PIL, which grey-fills), which is exactly the signal
 * the search needs: a decode SUCCEEDS only when the scan fully fills the candidate frame, so the
 * largest frame that decodes fixes the area and the tallest that decodes fixes the height.
 *
 * Cracked keylessly 2026-06-04; verified against a live V6 production thumbnail (632×472, 4:4:4).
 *
 * @remarks
 * Depends on `jpeg-js` (v0.4.x, BSD-3-Clause, pure-JS, **zero transitive dependencies**). A baseline
 * JPEG codec is unavoidable here — the search must decode candidate frames (to detect scan-fill and to
 * read pixels for the colour/shear metrics), and the de-fog step re-encodes the corrected image.
 * `jpeg-js` specifically is required because this decoder *throws on an under-filled frame*, which is
 * the precise signal the geometry search below depends on — libjpeg/mozjpeg-based codecs (`@jsquash`,
 * `sharp`) grey-fill instead, which would silently break the search.
 *
 * **Cost:** `jpeg-js` is synchronous pure JS, so a reconstruction holds the event loop for its whole
 * duration and simultaneous thumbnails queue behind it. The synthetic 176×144 and 264×200 fixtures
 * measured 168 ms and 256 ms, at a peak of 47 MB and 52 MB of resident memory, on one Node 24 test
 * host; both vary with the image and the hardware. The peak is candidate frames, not the thumbnail —
 * a decoder allocates a frame's component buffers before it can discover the scan does not fill it,
 * which is why {@link ladderByMcuCount} exists.
 *
 * @module transport/http/decodeImageV2
 */
import { decode as jpegDecode, encode as jpegEncode } from "jpeg-js";

/** The `v2_eufysecurity:` wrapper prefix (including the trailing colon) that tags a v2 blob. */
const V2_PREFIX = "v2_eufysecurity:";

/** The standard baseline DC-chrominance Huffman marker — the first plaintext byte of the v2 tail. */
const DC_CHROMA = Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x01]);

/** Zig-zag scan order — DQT segments store the 8×8 quant table in this order. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

/**
 * Standard Annex-K base luma quantization table (natural order, quality 50). The original is lost with
 * the encrypted prefix; this gives a viewable image with only a mild tone shift.
 */
// prettier-ignore
const QUANT_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Standard Annex-K base chroma quantization table (natural order, quality 50); see {@link QUANT_LUMA}. */
// prettier-ignore
const QUANT_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/**
 * The standard DC-luma Huffman table (Annex K.3), as a complete DHT segment. The chroma DHTs come from
 * the plaintext tail, so only the luma tables belong in the reconstructed header.
 */
const DHT_DC_LUMA = Buffer.from("ffc4001f0000010501010101010100000000000000000102030405060708090a0b", "hex");

/** The standard AC-luma Huffman table (Annex K.3), as a complete DHT segment; see {@link DHT_DC_LUMA}. */
const DHT_AC_LUMA = Buffer.from(
  "ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c1" +
    "1552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768" +
    "696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7" +
    "c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa",
  "hex",
);

const SOI = Buffer.from([0xff, 0xd8]);
const APP0 = Buffer.from("ffe000104a46494600010100000100010000", "hex");

/** Subsampling id → MCU pixel size [w, h]: 0 = 4:4:4, 1 = 4:2:2, 2 = 4:2:0. */
const MCU: Record<number, [number, number]> = { 0: [8, 8], 1: [16, 8], 2: [16, 16] };

/**
 * Common camera/doorbell frame sizes (16:9, 4:3, plus portrait), used as the coarse geometry grid.
 */
// prettier-ignore
const LADDER: [number, number][] = [
  [160, 90], [240, 135], [256, 144], [320, 180], [384, 216], [400, 225], [480, 270], [512, 288], [576, 324],
  [640, 360], [704, 396], [768, 432], [848, 480], [960, 540], [1024, 576], [1280, 720], [1600, 900], [1920, 1080],
  [176, 144], [320, 240], [352, 288], [480, 360], [640, 480], [800, 600], [1024, 768], [256, 480], [320, 384],
];

function scaleQuant(base: readonly number[], quality: number): number[] {
  const factor = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * factor + 50) / 100))));
}

function dqtSegment(table: readonly number[], id: number, quality: number): Buffer {
  const q = scaleQuant(table, quality);
  const body = Buffer.alloc(65);
  body[0] = id;
  for (let i = 0; i < 64; i++) body[1 + i] = q[ZIGZAG[i]];
  return Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43]), body]);
}

/** Build the SOF0 segment for a baseline JPEG of the given geometry. */
function sofSegment(width: number, height: number, subsampling: number): Buffer {
  const samplingFactors = subsampling === 2 ? 0x22 : subsampling === 1 ? 0x21 : 0x11;
  // prettier-ignore
  return Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, samplingFactors, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

/** A standard baseline JPEG header for (width, height, subsampling), ending right before the DC-chroma DHT. */
function buildHeader(width: number, height: number, subsampling: number, quality = 85): Buffer {
  return Buffer.concat([
    SOI,
    APP0,
    dqtSegment(QUANT_LUMA, 0, quality),
    dqtSegment(QUANT_CHROMA, 1, quality),
    sofSegment(width, height, subsampling),
    DHT_DC_LUMA,
    DHT_AC_LUMA,
  ]);
}

interface Decoded {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Splice a header for (width, height, subsampling) onto the tail and decode; null if the scan doesn't fill the frame. */
function decodeCandidate(tail: Buffer, width: number, height: number, subsampling: number): Decoded | null {
  try {
    const jpeg = Buffer.concat([buildHeader(width, height, subsampling), tail]);
    return jpegDecode(jpeg, { useTArray: true, maxMemoryUsageInMB: 128 });
  } catch {
    return null;
  }
}

/** Mean per-pixel colour channel spread — high when the chroma subsampling guess is wrong. */
function colorSpread(img: Decoded): number {
  const { width, height, data } = img;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < width * height; i += 37) {
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    sum += Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r);
    count++;
  }
  return count ? sum / count : Number.POSITIVE_INFINITY;
}

/** Mean row-to-row luma difference — high when the width guess shears every row. */
function rowShear(img: Decoded, rows: number): number {
  const { width, data } = img;
  let sum = 0;
  let count = 0;
  for (let y = 1; y < rows; y++) {
    for (let x = 0; x < width; x += 4) {
      sum += Math.abs(data[(y * width + x) * 4] - data[((y - 1) * width + x) * 4]);
      count++;
    }
  }
  return count ? sum / count : Number.POSITIVE_INFINITY;
}

/**
 * Per-channel auto-contrast, a byte-exact port of PIL `ImageOps.autocontrast` (cutoff 0.5%). The lost
 * quant tables leave the reconstruction low-contrast ("foggy"); stretching each channel's clipped range
 * to full scale restores a natural-looking image. Mutates `data` (RGBA) in place.
 *
 * Parity notes vs PIL: the cutoff count is `n * cutoff // 100` (integer floor); it is trimmed off each
 * end by zeroing whole histogram bins until the count is spent; the range is then the first/last
 * non-empty bins; and the LUT truncates toward zero (`int()`), NOT rounds — rounding would shift pixels.
 */
export function autoContrast(data: Uint8Array, width: number, height: number, cutoff = 0.5): void {
  const total = width * height;
  for (let channel = 0; channel < 3; channel++) {
    const hist = new Array<number>(256).fill(0);
    for (let i = 0; i < total; i++) hist[data[i * 4 + channel]]++;

    let remaining = Math.floor((total * cutoff) / 100);
    for (let bin = 0; bin < 256 && remaining > 0; bin++) {
      if (remaining > hist[bin]) {
        remaining -= hist[bin];
        hist[bin] = 0;
      } else {
        hist[bin] -= remaining;
        remaining = 0;
      }
    }
    remaining = Math.floor((total * cutoff) / 100);
    for (let bin = 255; bin >= 0 && remaining > 0; bin--) {
      if (remaining > hist[bin]) {
        remaining -= hist[bin];
        hist[bin] = 0;
      } else {
        hist[bin] -= remaining;
        remaining = 0;
      }
    }

    let lo = 0;
    while (lo < 256 && hist[lo] === 0) lo++;
    let hi = 255;
    while (hi >= 0 && hist[hi] === 0) hi--;
    if (hi <= lo) continue;

    const scale = 255 / (hi - lo);
    const offset = -lo * scale;
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.max(0, Math.trunc(v * scale + offset)));
    for (let i = 0; i < total; i++) data[i * 4 + channel] = lut[data[i * 4 + channel]];
  }
}

/** The tallest height (in MCU steps) that still decodes at this width — i.e. the scan's fill height. */
function maxHeight(tail: Buffer, width: number, subsampling: number, seed: number): number {
  const mcuHeight = MCU[subsampling][1];
  let height = Math.max(mcuHeight, Math.round(seed / mcuHeight) * mcuHeight);
  if (!decodeCandidate(tail, width, height, subsampling)) {
    while (height > mcuHeight && !decodeCandidate(tail, width, height, subsampling)) height -= mcuHeight;
  } else {
    while (height < 4096 && decodeCandidate(tail, width, height + mcuHeight, subsampling)) height += mcuHeight;
  }
  return height;
}

/**
 * The coarse ladder ordered by MCU count, ascending.
 *
 * Whether a candidate decodes is monotone in its MCU count: the plaintext scan carries a fixed number
 * of MCUs, and any frame demanding more of them runs out of entropy-coded data and throws. Walked in
 * this order, the first candidate that fails is the last one worth attempting, and the largest frame
 * that decodes is the one before it — so the search never builds a frame it can already prove the scan
 * cannot fill.
 *
 * That proof is what bounds the cost. A decoder discovers the shortfall only after allocating the
 * candidate's full component buffers, so an unbounded walk pays for every oversized frame on the
 * ladder: recovering a 176x144 thumbnail measured 98 candidate decodes totalling 29.7 Mpx, of which
 * 29.2 Mpx was spent by candidates that then threw, three of them at 1920x1080. Ordered, the same
 * reconstruction costs 47 MB of peak RSS instead of 158, and 168 ms instead of 1490.
 */
function ladderByMcuCount(subsampling: number): [number, number][] {
  const [mcuWidth, mcuHeight] = MCU[subsampling]!;
  const mcus = ([width, height]: [number, number]): number => (width / mcuWidth) * (height / mcuHeight);
  return [...LADDER].sort((a, b) => mcus(a) - mcus(b));
}

/** True if the blob is a v2 `v2_eufysecurity:` push thumbnail. */
export function isV2Image(data: Buffer): boolean {
  return data.length >= V2_PREFIX.length && data.subarray(0, V2_PREFIX.length).toString("latin1") === V2_PREFIX;
}

/**
 * Decode a v2 blob to a plain JPEG buffer by reconstructing its header, or null if it isn't v2 or the
 * plaintext scan can't be located. The search first chooses subsampling and coarse geometry, derives
 * the fixed MCU count, refines width by row shear, and pins the exact fill height before applying
 * auto-contrast and re-encoding. See the module doc for the keyless-splice rationale.
 */
export function decodeImageV2(data: Buffer): Buffer | null {
  if (!isV2Image(data)) return null;
  const cut = data.indexOf(DC_CHROMA);
  if (cut < 0) return null;
  const tail = data.subarray(cut);

  let best: { spread: number; subsampling: number; width: number; height: number } | null = null;
  for (const subsampling of [2, 0, 1]) {
    let filled: { width: number; height: number; img: Decoded } | null = null;
    for (const [width, height] of ladderByMcuCount(subsampling)) {
      const img = decodeCandidate(tail, width, height, subsampling);
      if (!img) break;
      if (!filled || width * height > filled.width * filled.height) filled = { width, height, img };
    }
    if (!filled) continue;
    const spread = colorSpread(filled.img);
    if (!best || spread < best.spread) best = { spread, subsampling, width: filled.width, height: filled.height };
  }
  if (!best) return null;

  const { subsampling, width: coarseWidth } = best;
  const [mcuWidth, mcuHeight] = MCU[subsampling];

  const coarseHeight = maxHeight(tail, coarseWidth, subsampling, best.height);
  const totalMcus = (coarseWidth / mcuWidth) * (coarseHeight / mcuHeight);

  let width = coarseWidth;
  let height = coarseHeight;
  let bestShear = Number.POSITIVE_INFINITY;
  const lowWidth = Math.max(mcuWidth * 4, Math.round((coarseWidth * 0.75) / mcuWidth) * mcuWidth);
  const highWidth = Math.round((coarseWidth * 1.25) / mcuWidth) * mcuWidth;
  for (let candidateWidth = lowWidth; candidateWidth <= highWidth; candidateWidth += mcuWidth) {
    const candidateHeight = Math.floor(totalMcus / (candidateWidth / mcuWidth)) * mcuHeight;
    if (candidateHeight < mcuHeight) continue;
    const img = decodeCandidate(tail, candidateWidth, candidateHeight, subsampling);
    if (!img) continue;
    const shear = rowShear(img, candidateHeight);
    if (shear < bestShear) {
      bestShear = shear;
      width = candidateWidth;
      height = candidateHeight;
    }
  }

  height = maxHeight(tail, width, subsampling, height);
  const img = decodeCandidate(tail, width, height, subsampling);
  if (!img) return null;

  autoContrast(img.data, img.width, img.height);
  return Buffer.from(jpegEncode({ data: img.data, width: img.width, height: img.height }, 90).data);
}
