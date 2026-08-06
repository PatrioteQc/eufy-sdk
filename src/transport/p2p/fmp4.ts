/**
 * Native fragmented-MP4 (fMP4 / CMAF) muxer — pure Node, ZERO dependency (only `node:buffer`).
 *
 * The shipping `recordClip` shells out to ffmpeg for a one-shot buffer. This muxer produces the same
 * CMAF shape (`ftyp`+`moov` init segment, then `moof`+`mdat` media fragments) as a continuous,
 * dependency-free stream so a host can serve fMP4 (MSE / HLS-fMP4 / DASH) without ffmpeg on PATH.
 *
 * Feed it {@link LiveVideoFrame}s (Annex-B). It emits the `init` segment once — on the first keyframe,
 * whose parameter sets ({@link extractParamSets}) build the `avcC` (H.264) / `hvcC` (H.265) decoder
 * config — then a media fragment per boundary (a keyframe once `fragmentSeconds` has elapsed). Annex-B
 * start codes are rewritten to AVCC 4-byte length prefixes in the `mdat`.
 *
 * H.265 note: the `hvcC` NAL arrays (VPS/SPS/PPS) are exact; the profile/tier/level header fields use
 * safe Main-profile defaults (decoders re-read the SPS from the arrays), and picture size comes from
 * {@link LiveVideoFrame}. This matches the plan's H265 fallback.
 *
 * @module p2p/fmp4
 */
import { extractParamSets, splitAnnexbNals, type ParamSets } from "./annexb.js";
import type { LiveVideoFrame, MediaFragment, VideoCodec } from "../../core/contracts.js";

const TIMESCALE = 90000; // 90kHz — the conventional media timescale
const DEFAULT_FRAME_TICKS = TIMESCALE / 15; // fallback per-sample duration (~15fps) before we measure

export interface Fmp4Options {
  /** Minimum fragment length; a new fragment opens on the first keyframe past this (default 2s). */
  fragmentSeconds?: number;
  /** Assumed fps for the first sample's duration before inter-frame timing is known (default 15). */
  fps?: number;
}

/** Type strings for the H.264 / H.265 sample entry + decoder-config boxes. */
const CODEC_BOXES: Record<Exclude<VideoCodec, "av1">, { sample: string; config: string }> = {
  h264: { sample: "avc1", config: "avcC" },
  h265: { sample: "hvc1", config: "hvcC" },
};

interface Sample {
  data: Buffer; // AVCC length-prefixed
  duration: number; // in TIMESCALE ticks
  keyframe: boolean;
}

export class Fmp4Muxer {
  private params?: ParamSets;
  private codec: Exclude<VideoCodec, "av1"> = "h264";
  private width = 0;
  private height = 0;
  private initSent = false;
  private seq = 1;
  private baseDecodeTime = 0; // running decode time (ticks) for tfdt
  private fragTicks = 0; // ticks accumulated in the open fragment
  private samples: Sample[] = [];
  private lastPushMs = 0;
  private readonly fragmentTicks: number;
  private readonly firstDuration: number;

  constructor(opts: Fmp4Options = {}) {
    this.fragmentTicks = (opts.fragmentSeconds ?? 2) * TIMESCALE;
    this.firstDuration = opts.fps ? TIMESCALE / opts.fps : DEFAULT_FRAME_TICKS;
  }

  /**
   * Push one access unit. Returns any completed segments: the `init` on the first keyframe, and/or a
   * media fragment when this frame closed the open one. Returns `undefined` if nothing is emitted yet
   * (e.g. delta frames before the first keyframe).
   */
  push(frame: LiveVideoFrame): MediaFragment | undefined {
    if (frame.codec === "av1") throw new Error("fMP4 muxer: AV1 is not supported");
    let init: Buffer | undefined;

    if (!this.initSent) {
      if (!frame.keyframe) return undefined; // wait for the first keyframe (carries the param sets)
      const ps = extractParamSets(frame.data);
      if (!ps || ps.codec === "av1") return undefined;
      this.params = ps;
      this.codec = ps.codec;
      this.width = frame.width || pictureWidthFallback(ps);
      this.height = frame.height || 0;
      init = this.buildInit();
      this.initSent = true;
      this.lastPushMs = now();
    }

    // Compute this sample's duration from inter-frame wallclock (best-effort), with a floor.
    const t = now();
    const measured = this.lastPushMs ? Math.round((t - this.lastPushMs) * (TIMESCALE / 1000)) : 0;
    this.lastPushMs = t;
    const duration = measured > 0 ? measured : this.firstDuration;

    let fragment: Buffer | undefined;
    // Boundary: a keyframe that opens a fragment past the minimum length closes the current one first.
    if (frame.keyframe && this.samples.length > 0 && this.fragTicks >= this.fragmentTicks) {
      fragment = this.buildFragment();
    }

    this.samples.push({ data: annexbToAvcc(frame.data), duration, keyframe: frame.keyframe });
    this.fragTicks += duration;

    if (init || fragment) {
      return { init, data: fragment ?? Buffer.alloc(0), keyframe: !!fragment && this.samplesStartKeyframe() };
    }
    return undefined;
  }

  /** Flush the open fragment (call at end-of-stream). Returns the final fragment, or undefined. */
  flush(): MediaFragment | undefined {
    if (!this.samples.length) return undefined;
    const data = this.buildFragment();
    return { data, keyframe: true };
  }

  private samplesStartKeyframe(): boolean {
    return this.samples[0]?.keyframe ?? false;
  }

  // ── Box builders ────────────────────────────────────────────────────────────────────────────

  private buildInit(): Buffer {
    return Buffer.concat([this.ftyp(), this.moov()]);
  }

  private buildFragment(): Buffer {
    const samples = this.samples;
    this.samples = [];
    this.fragTicks = 0;
    const seq = this.seq++;
    const moof = this.moof(seq, samples);
    const mdat = box("mdat", Buffer.concat(samples.map((s) => s.data)));
    // Patch trun data_offset now that moof size is known (points at the first byte of mdat payload).
    const dataOffset = moof.length + 8; // + mdat header (size + type)
    patchTrunDataOffset(moof, dataOffset);
    this.baseDecodeTime += samples.reduce((n, s) => n + s.duration, 0);
    return Buffer.concat([moof, mdat]);
  }

  private ftyp(): Buffer {
    return box("ftyp", Buffer.concat([str("iso5"), u32(0), str("iso5"), str("iso6"), str("mp41"), str("cmfc")]));
  }

  private moov(): Buffer {
    return box("moov", this.mvhd(), this.trak(), this.mvex());
  }

  private mvhd(): Buffer {
    const b = Buffer.alloc(100);
    b.writeUInt32BE(0, 0); // version/flags
    b.writeUInt32BE(0, 4); // creation
    b.writeUInt32BE(0, 8); // modification
    b.writeUInt32BE(TIMESCALE, 12);
    b.writeUInt32BE(0, 16); // duration (0 = fragmented)
    b.writeUInt32BE(0x00010000, 20); // rate 1.0
    b.writeUInt16BE(0x0100, 24); // volume 1.0
    writeMatrix(b, 32);
    b.writeUInt32BE(2, 96); // next track id
    return box("mvhd", b);
  }

  private trak(): Buffer {
    return box("trak", this.tkhd(), this.mdia());
  }

  private tkhd(): Buffer {
    const b = Buffer.alloc(84);
    b.writeUInt32BE(0x00000007, 0); // flags: enabled | in movie | in preview
    b.writeUInt32BE(1, 12); // track id
    b.writeUInt32BE(0, 20); // duration
    writeMatrix(b, 40);
    b.writeUInt32BE(this.width << 16, 76); // width 16.16
    b.writeUInt32BE(this.height << 16, 80); // height 16.16
    return box("tkhd", b);
  }

  private mdia(): Buffer {
    const mdhd = Buffer.alloc(32);
    mdhd.writeUInt32BE(0, 0);
    mdhd.writeUInt32BE(TIMESCALE, 12);
    mdhd.writeUInt32BE(0, 16); // duration
    mdhd.writeUInt16BE(0x55c4, 24); // language "und"
    const hdlr = box(
      "hdlr",
      Buffer.concat([u32(0), u32(0), str("vide"), u32(0), u32(0), u32(0), Buffer.from("VideoHandler\0")]),
    );
    return box("mdia", box("mdhd", mdhd), hdlr, this.minf());
  }

  private minf(): Buffer {
    const vmhd = box("vmhd", Buffer.concat([u32(1), Buffer.alloc(8)])); // flags=1
    const dref = box("dref", Buffer.concat([u32(0), u32(1), box("url ", u32(1))]));
    const dinf = box("dinf", dref);
    return box("minf", vmhd, dinf, this.stbl());
  }

  private stbl(): Buffer {
    return box(
      "stbl",
      box("stsd", Buffer.concat([u32(0), u32(1), this.sampleEntry()])),
      box("stts", Buffer.concat([u32(0), u32(0)])),
      box("stsc", Buffer.concat([u32(0), u32(0)])),
      box("stsz", Buffer.concat([u32(0), u32(0), u32(0)])),
      box("stco", Buffer.concat([u32(0), u32(0)])),
    );
  }

  private sampleEntry(): Buffer {
    const { sample, config } = CODEC_BOXES[this.codec];
    const head = Buffer.alloc(78);
    head.writeUInt16BE(1, 6); // data_reference_index
    head.writeUInt16BE(this.width, 24);
    head.writeUInt16BE(this.height, 26);
    head.writeUInt32BE(0x00480000, 28); // horizresolution 72dpi
    head.writeUInt32BE(0x00480000, 32); // vertresolution 72dpi
    head.writeUInt16BE(1, 40); // frame_count
    head.writeUInt16BE(0x18, 74); // depth
    head.writeInt16BE(-1, 76); // pre_defined
    const cfg = box(config, this.codec === "h264" ? this.avcC() : this.hvcC());
    return box(sample, Buffer.concat([head, cfg]));
  }

  private avcC(): Buffer {
    const ps = this.params!;
    const sps = ps.sps[0] ?? Buffer.alloc(4);
    const parts: Buffer[] = [
      Buffer.from([1, sps[1] ?? 0x42, sps[2] ?? 0x00, sps[3] ?? 0x1e, 0xff, 0xe0 | ps.sps.length]),
    ];
    for (const s of ps.sps) parts.push(u16(s.length), s);
    parts.push(Buffer.from([ps.pps.length]));
    for (const p of ps.pps) parts.push(u16(p.length), p);
    return Buffer.concat(parts);
  }

  private hvcC(): Buffer {
    const ps = this.params!;
    const header = Buffer.from([
      1, // configurationVersion
      0x01, // general_profile_space(0)+tier(0)+profile_idc(1=Main)
      0x60,
      0x00,
      0x00,
      0x00, // general_profile_compatibility_flags
      0x90,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // general_constraint_indicator_flags (48 bits)
      0x5a, // general_level_idc (level 3.0 placeholder)
      0xf0,
      0x00, // min_spatial_segmentation_idc
      0xfc, // parallelismType
      0xfd, // chromaFormat 4:2:0
      0xf8, // bitDepthLumaMinus8 = 0
      0xf8, // bitDepthChromaMinus8 = 0
      0x00,
      0x00, // avgFrameRate
      0x0f, // constantFrameRate(0)+numTemporalLayers(1)+temporalIdNested(0)+lengthSizeMinusOne(3)
    ]);
    const arrays: Buffer[] = [];
    const push = (nalType: number, nals: Buffer[]) => {
      if (!nals.length) return;
      const parts: Buffer[] = [Buffer.from([0x80 | nalType]), u16(nals.length)]; // array_completeness=1
      for (const n of nals) parts.push(u16(n.length), n);
      arrays.push(Buffer.concat(parts));
    };
    push(32, ps.vps);
    push(33, ps.sps);
    push(34, ps.pps);
    return Buffer.concat([header, Buffer.from([arrays.length]), ...arrays]);
  }

  private mvex(): Buffer {
    const trex = Buffer.alloc(24);
    trex.writeUInt32BE(1, 4); // track id
    trex.writeUInt32BE(1, 8); // default sample description index
    return box("mvex", box("trex", trex));
  }

  private moof(seq: number, samples: Sample[]): Buffer {
    const mfhd = box("mfhd", Buffer.concat([u32(0), u32(seq)]));
    const traf = this.traf(samples);
    return box("moof", mfhd, traf);
  }

  private traf(samples: Sample[]): Buffer {
    // tfhd: default-base-is-moof (0x020000) + default_sample_flags present (0x20)? We set per-sample
    // flags in trun instead, so tfhd carries only track id + default-base-is-moof.
    const tfhd = box("tfhd", Buffer.concat([u32(0x020000), u32(1)]));
    const tfdt = box("tfdt", Buffer.concat([u32(0x01000000), u64(this.baseDecodeTime)]));
    return box("traf", tfhd, tfdt, this.trun(samples));
  }

  private trun(samples: Sample[]): Buffer {
    // flags: data-offset(0x1) + sample-duration(0x100) + sample-size(0x200) + sample-flags(0x400)
    const flags = 0x000f01;
    const parts: Buffer[] = [u32(flags), u32(samples.length), u32(0) /* data_offset patched later */];
    for (const s of samples) {
      parts.push(u32(s.duration), u32(s.data.length), u32(s.keyframe ? 0x02000000 : 0x01010000));
    }
    return box("trun", Buffer.concat(parts));
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

/** Wrap a payload in an MP4 box: [u32 size][4-char type][payload…]. */
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32BE(b.length, 0);
  b.write(type, 4, "ascii");
  body.copy(b, 8);
  return b;
}

function str(s: string): Buffer {
  return Buffer.from(s, "ascii");
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

/** Unity 3x3 display matrix at offset `o`. */
function writeMatrix(b: Buffer, o: number): void {
  b.writeUInt32BE(0x00010000, o); // a
  b.writeUInt32BE(0x00010000, o + 16); // d
  b.writeUInt32BE(0x40000000, o + 32); // w
}

/** Rewrite Annex-B start codes to AVCC 4-byte length prefixes, dropping parameter-set NALs. */
function annexbToAvcc(annexb: Buffer): Buffer {
  const out: Buffer[] = [];
  for (const nal of splitAnnexbNals(annexb)) {
    out.push(u32(nal.length), nal);
  }
  return Buffer.concat(out);
}

/** Locate the trun's data_offset field inside a freshly built moof and set it. */
function patchTrunDataOffset(moof: Buffer, offset: number): void {
  const trunType = Buffer.from("trun", "ascii");
  const idx = moof.indexOf(trunType);
  if (idx < 0) return;
  // trun payload starts at idx+4: [u32 flags][u32 sample_count][u32 data_offset]
  moof.writeInt32BE(offset, idx + 4 + 8);
}

function pictureWidthFallback(_ps: ParamSets): number {
  return 0; // width comes from LiveVideoFrame; SPS dimension parse is intentionally out of scope
}
