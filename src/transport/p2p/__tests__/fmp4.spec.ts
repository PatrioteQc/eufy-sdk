import { Fmp4Muxer } from "../fmp4.js";
import type { LiveVideoFrame, VideoCodec } from "../../../core/contracts.js";

const SC4 = Buffer.from([0, 0, 0, 1]);
function annexb(...nals: Buffer[]): Buffer {
  return Buffer.concat(nals.flatMap((n) => [SC4, n]));
}

const H264_SPS = Buffer.from([0x67, 0x42, 0xc0, 0x1e, 0xaa, 0xbb]);
const H264_PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
const H264_IDR = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x11, 0x22]);
const H264_P = Buffer.from([0x21, 0x9a, 0x00, 0x33]);

const H265_VPS = Buffer.from([0x40, 0x01, 0x0c, 0x01]);
const H265_SPS = Buffer.from([0x42, 0x01, 0x01, 0x22]);
const H265_PPS = Buffer.from([0x44, 0x01, 0xc0]);
const H265_IDR = Buffer.from([0x26, 0x01, 0xaf, 0xff]);

function kf(codec: VideoCodec): LiveVideoFrame {
  const data = codec === "h265" ? annexb(H265_VPS, H265_SPS, H265_PPS, H265_IDR) : annexb(H264_SPS, H264_PPS, H264_IDR);
  return { keyframe: true, width: 1280, height: 720, codec, data };
}
function delta(codec: VideoCodec): LiveVideoFrame {
  return {
    keyframe: false,
    width: 1280,
    height: 720,
    codec,
    data: annexb(codec === "h265" ? Buffer.from([0x02, 1]) : H264_P),
  };
}

/** Walk the top-level MP4 box list of a buffer → [{type, start, size}]. */
function boxes(buf: Buffer): { type: string; start: number; size: number }[] {
  const out: { type: string; start: number; size: number }[] = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const size = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    if (size < 8) break;
    out.push({ type, start: o, size });
    o += size;
  }
  return out;
}

/** Recursively find the first box of `type` anywhere in the buffer (container-agnostic scan). */
function findBox(buf: Buffer, type: string): Buffer | undefined {
  const t = Buffer.from(type, "ascii");
  const idx = buf.indexOf(t);
  if (idx < 4) return undefined;
  const start = idx - 4;
  const size = buf.readUInt32BE(start);
  return buf.subarray(start, start + size);
}

describe("Fmp4Muxer H.264", () => {
  it("emits an init segment (ftyp+moov) on the first keyframe with an avcC embedding the SPS", () => {
    const mux = new Fmp4Muxer();
    const out = mux.push(kf("h264"));
    expect(out?.init).toBeDefined();
    const top = boxes(out!.init!).map((b) => b.type);
    expect(top).toEqual(["ftyp", "moov"]);
    const avcc = findBox(out!.init!, "avcC");
    expect(avcc).toBeDefined();
    // avcC body carries the SPS bytes verbatim
    expect(avcc!.includes(H264_SPS)).toBe(true);
    expect(avcc!.includes(H264_PPS)).toBe(true);
    // sample entry is avc1
    expect(findBox(out!.init!, "avc1")).toBeDefined();
  });

  it("opens a media fragment (moof+mdat) on the next keyframe past the fragment length", () => {
    const mux = new Fmp4Muxer({ fragmentSeconds: 0 }); // any keyframe is a boundary
    mux.push(kf("h264")); // init
    mux.push(delta("h264"));
    const out = mux.push(kf("h264")); // closes fragment 1
    expect(out?.data.length).toBeGreaterThan(0);
    const top = boxes(out!.data).map((b) => b.type);
    expect(top).toEqual(["moof", "mdat"]);
  });

  it("rewrites Annex-B start codes to AVCC length prefixes in the mdat", () => {
    const mux = new Fmp4Muxer({ fragmentSeconds: 0 });
    mux.push(kf("h264"));
    const frag = mux.flush()!;
    const mdat = findBox(frag.data, "mdat")!;
    // first sample: [u32 len][nal…] — no Annex-B start code present
    expect(mdat.subarray(8, 12).equals(SC4)).toBe(false);
    const firstLen = mdat.readUInt32BE(8);
    expect(firstLen).toBe(H264_SPS.length); // first NAL is the SPS
    expect(mdat.subarray(12, 12 + firstLen).equals(H264_SPS)).toBe(true);
  });

  it("does not emit before the first keyframe", () => {
    const mux = new Fmp4Muxer();
    expect(mux.push(delta("h264"))).toBeUndefined();
  });
});

describe("Fmp4Muxer H.265", () => {
  it("builds an hvcC with hvc1 sample entry and VPS/SPS/PPS arrays", () => {
    const mux = new Fmp4Muxer();
    const out = mux.push(kf("h265"));
    expect(out?.init).toBeDefined();
    expect(findBox(out!.init!, "hvc1")).toBeDefined();
    const hvcc = findBox(out!.init!, "hvcC")!;
    expect(hvcc.includes(H265_VPS)).toBe(true);
    expect(hvcc.includes(H265_SPS)).toBe(true);
    expect(hvcc.includes(H265_PPS)).toBe(true);
  });
});
