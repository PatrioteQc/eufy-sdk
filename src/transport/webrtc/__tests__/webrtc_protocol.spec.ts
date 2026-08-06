import {
  SIGNAL_MAGIC,
  SIGNAL_HEADER_BYTES,
  RtcCommand,
  SignCode,
  VERSION_GCM,
  encodeFrame,
  encodeHeader,
  parseHeader,
  extractFrames,
} from "../protocol.js";
import { encryptSignalBody, decryptSignalBody } from "../crypto.js";
import { wrapObfuscate, unwrapObfuscate } from "../obfuscate.js";
import { extractWebrtcParams } from "../params.js";
import { randomBytes } from "crypto";

describe("webrtc signaling protocol", () => {
  it("magic is little-endian 'XZYH'", () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(SIGNAL_MAGIC, 0);
    expect(buf.toString("ascii")).toBe("XZYH");
  });

  it("encodes/parses a 16-byte header round-trip", () => {
    const body = Buffer.from("hello signaling");
    const frame = encodeFrame(
      { commandId: RtcCommand.INFO, version: VERSION_GCM, channelId: 1, signCode: SignCode.GCM, devType: 48 },
      body,
    );
    expect(frame.length).toBe(SIGNAL_HEADER_BYTES + body.length);
    const h = parseHeader(frame)!;
    expect(h.commandId).toBe(RtcCommand.INFO);
    expect(h.paramLen).toBe(body.length);
    expect(h.version).toBe(VERSION_GCM);
    expect(h.channelId).toBe(1);
    expect(h.signCode).toBe(SignCode.GCM);
    expect(h.devType).toBe(48);
  });

  it("rejects a header with bad magic", () => {
    const bad = Buffer.alloc(16, 0);
    expect(parseHeader(bad)).toBeUndefined();
  });

  it("extractFrames pulls multiple frames and keeps a partial remainder", () => {
    const f1 = encodeFrame({ commandId: RtcCommand.PING }, Buffer.from("a"));
    const f2 = encodeFrame({ commandId: RtcCommand.CALL }, Buffer.from("bbbb"));
    const partial = encodeFrame({ commandId: RtcCommand.MSG }, Buffer.from("xxxxxxxx")).subarray(0, 10);
    const { frames, rest } = extractFrames(Buffer.concat([f1, f2, partial]));
    expect(frames.map((f) => f.header.commandId)).toEqual([RtcCommand.PING, RtcCommand.CALL]);
    expect(frames[1].body.toString()).toBe("bbbb");
    expect(rest.length).toBe(10); // the incomplete frame is held back
  });

  it("resyncs past garbage to the next XZYH magic", () => {
    const good = encodeFrame({ commandId: RtcCommand.ANSWER }, Buffer.from("ok"));
    const { frames } = extractFrames(Buffer.concat([Buffer.from([1, 2, 3]), good]));
    expect(frames).toHaveLength(1);
    expect(frames[0].header.commandId).toBe(RtcCommand.ANSWER);
  });
});

describe("webrtc signaling body crypto (AES-128-GCM)", () => {
  it("encrypts/decrypts round-trip with TAG‖IV‖CT layout", () => {
    const key = randomBytes(16);
    const plain = Buffer.from(JSON.stringify({ sdp: "v=0...", uuid: "abc", calltype: 1 }));
    const enc = encryptSignalBody(key, plain);
    expect(enc.length).toBe(16 + 12 + plain.length); // TAG ‖ IV ‖ CT
    expect(decryptSignalBody(key, enc)!.equals(plain)).toBe(true);
  });

  it("decrypts the reserved(4)-prefixed variant too", () => {
    const key = randomBytes(16);
    const plain = Buffer.from("hello");
    const enc = encryptSignalBody(key, plain, { reserved4: true });
    expect(enc.length).toBe(4 + 16 + 12 + plain.length);
    expect(enc.subarray(0, 4).equals(Buffer.alloc(4))).toBe(true);
    expect(decryptSignalBody(key, enc)!.equals(plain)).toBe(true);
  });

  it("fails closed on wrong key / tampering", () => {
    const enc = encryptSignalBody(randomBytes(16), Buffer.from("secret"));
    expect(decryptSignalBody(randomBytes(16), enc)).toBeUndefined();
    enc[2] ^= 0xff; // corrupt the auth tag
    expect(decryptSignalBody(randomBytes(16), enc)).toBeUndefined();
  });

  it("rejects non-16-byte keys", () => {
    expect(() => encryptSignalBody(randomBytes(32), Buffer.alloc(1))).toThrow();
  });
});

describe("webrtc obfuscation envelope (NewRTCProtocol)", () => {
  it("wrap/unwrap round-trips an XZYH frame", () => {
    const frame = encodeFrame(
      { commandId: RtcCommand.LOGIN, signCode: SignCode.GCM, version: VERSION_GCM },
      Buffer.from("creds"),
    );
    const env = wrapObfuscate(frame);
    expect(env.readUInt16LE(0)).toBe(0x0008); // magic
    expect(env.length).toBeGreaterThanOrEqual(0x17);
    expect(unwrapObfuscate(env)!.equals(frame)).toBe(true);
  });

  it("obfuscates the payload (not plaintext on the wire) and survives zero padding", () => {
    const frame = encodeFrame({ commandId: RtcCommand.INFO }, Buffer.from("v=0\r\nm=video"));
    const env = wrapObfuscate(frame, 0);
    expect(env[0x14]).toBe(0); // padLen
    expect(env.subarray(0x16, 0x16 + frame.length).equals(frame)).toBe(false); // XOR'd, not raw
    expect(unwrapObfuscate(env)!.equals(frame)).toBe(true);
  });

  it("rejects malformed envelopes", () => {
    expect(unwrapObfuscate(Buffer.alloc(4))).toBeUndefined();
    expect(unwrapObfuscate(Buffer.alloc(0x20, 0))).toBeUndefined(); // magic != 8
  });
});

describe("webrtc device params", () => {
  it("extracts signaling params from a get_device_list record", () => {
    const raw = {
      device_sn: "T8170T0000000000",
      device_channel: 1,
      signaling_servers: ["https://webrtc-signal-eu.eufylife.com", "https://75.2.46.73"],
      p2p_did: "EUPRCAM-000000-XXXXX",
      p2p_conn: "EDHN...",
      p2p_license: "XXXXXX",
    };
    const p = extractWebrtcParams(raw)!;
    expect(p.deviceSn).toBe("T8170T0000000000");
    expect(p.channel).toBe(1);
    expect(p.signalingServers).toHaveLength(2);
    expect(p.p2pDid).toBe("EUPRCAM-000000-XXXXX");
    expect(p.p2pLicense).toBe("XXXXXX");
  });

  it("returns undefined when signaling fields are absent", () => {
    expect(extractWebrtcParams({ device_sn: "x" })).toBeUndefined();
    expect(extractWebrtcParams(undefined)).toBeUndefined();
  });
});
