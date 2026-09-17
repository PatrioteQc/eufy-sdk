/**
 * Decoder tests for the Solix telemetry layer, using a REAL ff09 param frame captured live from a
 * Smart Meter Gen 2 (AE1X0) over AWS-IoT MQTT — deterministic, offline, no network.
 */
import { describe, expect, it } from "vitest";

import {
  buildFf09Request,
  decodeSolixParamFrame,
  extractFf09Payload,
  readSolixChannel,
  solixReadings,
} from "../solix-mqtt.js";

// Captured from dt/anker_power/AE1X0/AE1X0EXAMPLE00001/param_info (grid idle; voltage ~237.5 V).
const FRAME_HEX =
  "ff09a00003010f0405a10134a2120041453158304558414d504c453030303031a3020100a6050309000001" +
  "a8050500000000a9050500000000aa050500000000ab050500000000ac050500806d43ad050500000000" +
  "ae050500000000af050500000000b0050500000000b1050500000000b2050500000000b3050500000000" +
  "b4050500000000b5050500000000b6050500000000b7050500000000b802010344";
const FRAME = Buffer.from(FRAME_HEX, "hex");

// A SECOND live AE1X0 capture, this one with the meter under load (a small net grid import): the REAL
// on-wire frame with only the device serial redacted to the synthetic id and the trailing XOR
// recomputed for that swap — NOT a synthesised one. This matters for the a8/ab pair: `meterPowerL1 ==
// meterPowerTotal` here because the DEVICE itself reported the two slots equal (its own bytes), so the
// L1==total mirror is independently corroborated by a real observation, not by writing the same bytes
// to both slots. It carries a real line current + voltage, a cumulative import counter, and `0xb2` a
// small constant that does NOT track load — the whole point of a load-varying frame the idle one can't be.
const LOAD_FRAME_HEX =
  "ff09a00003010f0405a10134a2120041453158304558414d504c453030303031a3020100a6050309000001" +
  "a80505cdcc2c40a9050500000000aa050500000000ab0505cdcc2c40ac0505cd4c6f43ad050500000000" +
  "ae050500000000af0505ee7caf3fb0050500000000b1050500000000b20505bc74133cb305054c379442" +
  "b4050500000000b5050500000000b6050500000000b70505cdcccc3db8020103ff";
const LOAD_FRAME = Buffer.from(LOAD_FRAME_HEX, "hex");

describe("Solix MQTT param decoding", () => {
  it("parses the ff09 frame's serial and TLV fields", () => {
    const frame = decodeSolixParamFrame(FRAME)!;
    expect(frame.deviceSn).toBe("AE1X0EXAMPLE00001");
    expect(frame.fields.has(0xac)).toBe(true);
    expect(frame.fields.get(0xa1)).toEqual(Buffer.from([0x34]));
  });

  it("rejects a non-ff09 buffer", () => {
    expect(decodeSolixParamFrame(Buffer.from("deadbeef", "hex"))).toBeNull();
  });

  it("reads a float32 channel from a type-0x05 value", () => {
    const ch = readSolixChannel(Buffer.from("0500806d43", "hex"))!;
    expect(ch.type).toBe(0x05);
    expect(ch.float).toBeCloseTo(237.5, 1);
  });

  it("names the twelve app fields for a meter frame, keeps reserved tags (0xb2) raw-only, emits every float as channel_<hex>", () => {
    const values = solixReadings(decodeSolixParamFrame(FRAME)!, "AE1X0");
    expect(values.meterVoltageL1).toBeCloseTo(237.5, 1);
    expect(values["channel_ac"]).toBeCloseTo(237.5, 1);
    // The named electrical fields + energy counters are emitted (0 on this idle single-phase frame).
    expect(values.meterPowerL1).toBe(0);
    expect(values.meterPowerTotal).toBe(0);
    expect(values.meterCurrentL1).toBe(0);
    expect(values.meterImportEnergy).toBe(0);
    expect(values["channel_a8"]).toBe(0);
    // 0xb2 names no field — it stays raw channel_b2 only, never a "meterCurrentTotal".
    expect(values["channel_b2"]).toBe(0);
    expect("meterCurrentTotal" in values).toBe(false);
    // a6 is a non-float type (0x03) → excluded from readings
    expect(values["channel_a6"]).toBeUndefined();
  });

  it("binds the meter fields against a real load-varying frame (L1 power == total, current, import; b2 constant)", () => {
    const values = solixReadings(decodeSolixParamFrame(LOAD_FRAME)!, "AE1X0");
    // The checksum-validated frame decodes (a corrupted one returns null and would fail here).
    expect(decodeSolixParamFrame(LOAD_FRAME)).not.toBeNull();
    // L1 line power equals the aggregate total on a single-phase install — the a8/ab mirror. Here the
    // device reported both slots as 2.7 W independently, so the equality corroborates the binding.
    expect(values.meterPowerL1).toBeCloseTo(2.7, 2);
    expect(values.meterPowerTotal).toBe(values.meterPowerL1);
    expect(values.meterVoltageL1).toBeCloseTo(239.3, 1);
    expect(values.meterCurrentL1).toBeCloseTo(1.371, 2);
    expect(values.meterImportEnergy).toBeCloseTo(74.108, 2);
    // 0xb2 is a small constant that does NOT scale with the load — so NOT a current total, and unnamed.
    expect(values["channel_b2"]).toBeCloseTo(0.009, 3);
    expect("meterCurrentTotal" in values).toBe(false);
    // L2/L3 slots are unconnected on a single-CT install → reported as 0 (present, not fabricated).
    expect(values.meterPowerL2).toBe(0);
    expect(values.meterCurrentL3).toBe(0);
  });

  it("withholds the meter tag→name table from a non-meter (Solarbank) frame, and from an unknown origin", () => {
    // A Solarbank (AE103) reports tag 0xac too, but it is a power value there, not a voltage — so the
    // meter name must NOT be borrowed. Every tag still surfaces raw as channel_<hex>.
    const solarbank = solixReadings(decodeSolixParamFrame(FRAME)!, "AE103");
    expect(solarbank.meterVoltageL1).toBeUndefined();
    expect(solarbank.meterPowerL1).toBeUndefined();
    expect(solarbank["channel_ac"]).toBeCloseTo(237.5, 1);
    // With no product code the table cannot be known to fit, so names are withheld too.
    expect(solixReadings(decodeSolixParamFrame(FRAME)!, "").meterVoltageL1).toBeUndefined();
  });

  it("extracts the ff09 payload from the {head, payload:{data}} MQTT envelope", () => {
    const envelope = { head: { cmd: 16 }, payload: JSON.stringify({ device_sn: "x", data: FRAME.toString("base64") }) };
    const buf = extractFf09Payload(envelope)!;
    expect(buf.equals(FRAME)).toBe(true);
    expect(decodeSolixParamFrame(buf)!.deviceSn).toBe("AE1X0EXAMPLE00001");
  });
});

// XOR-of-all-bytes == 0 iff the trailing checksum equals the XOR of every preceding byte — the ff09
// convention. Proven against the two live-captured requestDeviceInfo `data` frames.
const xorAll = (b: Buffer): number => b.reduce((a, x) => a ^ x, 0);

describe("Solix requestDeviceInfo ff09 request builder", () => {
  // From cmd/anker_power/AE1X0/<sn>/req, payload.data (base64), captured live. The fe-nonce carries a
  // unix timestamp at frame offset 14 ('info') / 24 ('realtime'), just before the trailing XOR byte.
  const infoCaptured = Buffer.from("/wkTAAMADwBAoQEi/gSau6NqOQ==", "base64");
  const realtimeCaptured = Buffer.from("/wkdAAMADwBXoQEiogIBAaMDAiwB/gUDmrujag0=", "base64");

  it("the checksum convention matches the real captured arming frames", () => {
    expect(xorAll(infoCaptured)).toBe(0); // trailing byte IS the XOR of all the rest
    expect(xorAll(realtimeCaptured)).toBe(0);
    expect(infoCaptured.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(infoCaptured.readUInt16LE(2)).toBe(infoCaptured.length); // declared len = total bytes
  });

  it("rebuilds the captured arming frames byte-for-byte at their captured timestamps", () => {
    // Inject each capture's own timestamp so the only variable is fixed → full byte-equality settles
    // that the builder reproduces the real frames exactly (not just length/checksum/tag presence).
    expect(buildFf09Request("info", infoCaptured.readUInt32LE(14)).equals(infoCaptured)).toBe(true);
    expect(buildFf09Request("realtime", realtimeCaptured.readUInt32LE(24)).equals(realtimeCaptured)).toBe(true);
  });

  it("builds a well-formed 'info' request (a1=0x22, valid ff09 + checksum)", () => {
    const f = buildFf09Request("info");
    expect(f.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(f.readUInt16LE(2)).toBe(f.length); // len field = total frame bytes
    expect(f.length).toBe(19); // same size as the captured 'info' frame
    expect(xorAll(f)).toBe(0); // checksum valid
    expect(f.includes(Buffer.from([0xa1, 0x01, 0x22]))).toBe(true); // request-type tag
  });

  it("builds a well-formed 'realtime' request (extra a2/a3 params)", () => {
    const f = buildFf09Request("realtime");
    expect(f.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(f.readUInt16LE(2)).toBe(f.length);
    expect(f.length).toBe(29); // same size as the captured 'realtime' frame
    expect(xorAll(f)).toBe(0);
    expect(f.includes(Buffer.from([0xa1, 0x01, 0x22]))).toBe(true);
    expect(f.includes(Buffer.from([0xa2, 0x02, 0x01, 0x01]))).toBe(true);
    expect(f.includes(Buffer.from([0xa3, 0x03, 0x02, 0x2c, 0x01]))).toBe(true);
  });
});
