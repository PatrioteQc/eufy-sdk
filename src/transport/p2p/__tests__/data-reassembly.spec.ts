import { describe, expect, it, vi } from "vitest";
import {
  buildCommandHeader,
  buildRawCommandPayload,
  frameMessage,
  P2PDataTypeHeader,
  RequestMessageType,
} from "../codec.js";
import { P2PSession, type P2PFrame } from "../p2p-session.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

function dataPacket(sequence: number, body: Buffer, dataTypeHeader = P2PDataTypeHeader.VIDEO): Buffer {
  const header = Buffer.alloc(4);
  dataTypeHeader.copy(header);
  header.writeUInt16BE(sequence, 2);
  return frameMessage(RequestMessageType.DATA, Buffer.concat([header, body]));
}

describe("P2P data reassembly", () => {
  it("ignores a retransmitted continuation without discarding the frame being assembled", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, logger });
    const target = session as unknown as {
      onData: (message: Buffer, address: { host: string; port: number }) => void;
      send: () => void;
    };
    target.send = vi.fn();
    const received: P2PFrame[] = [];
    session.on("data", (frame) => received.push(frame));

    const payload = Buffer.alloc(48, 7);
    const frame = Buffer.concat([
      buildCommandHeader(40, 1300, P2PDataTypeHeader.VIDEO).subarray(4),
      buildRawCommandPayload(payload),
    ]);
    const first = dataPacket(40, frame.subarray(0, 24));
    const middle = dataPacket(41, frame.subarray(24, 40));
    const last = dataPacket(42, frame.subarray(40));
    const address = { host: "127.0.0.1", port: 1 };

    target.onData(first, address);
    target.onData(middle, address);
    target.onData(dataPacket(40, frame.subarray(0, 24)), address);
    target.onData(middle, address);
    target.onData(last, address);

    expect(received).toHaveLength(1);
    expect(received[0]!.commandId).toBe(1300);
    expect(received[0]!.raw).toEqual(payload);
    expect(logger.debug).not.toHaveBeenCalledWith(
      "[live] start trace",
      expect.objectContaining({ phase: "datagram-gap" }),
    );
  });

  it("drops an incomplete frame on a genuine forward sequence gap and resynchronizes", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, logger });
    const target = session as unknown as {
      onData: (message: Buffer, address: { host: string; port: number }) => void;
      send: () => void;
    };
    target.send = vi.fn();
    const received: P2PFrame[] = [];
    session.on("data", (frame) => received.push(frame));
    const address = { host: "127.0.0.1", port: 1 };
    const payload = Buffer.alloc(48, 7);
    const incomplete = Buffer.concat([
      buildCommandHeader(40, 1300, P2PDataTypeHeader.VIDEO).subarray(4),
      buildRawCommandPayload(payload).subarray(0, 20),
    ]);
    const complete = Buffer.concat([
      buildCommandHeader(43, 1301, P2PDataTypeHeader.VIDEO).subarray(4),
      buildRawCommandPayload(Buffer.from([1, 2, 3])),
    ]);

    target.onData(dataPacket(40, incomplete), address);
    target.onData(dataPacket(42, Buffer.alloc(8)), address);
    target.onData(dataPacket(43, complete), address);

    expect(received).toHaveLength(1);
    expect(received[0]!.commandId).toBe(1301);
    expect(logger.debug).toHaveBeenCalledWith("[live] start trace", { phase: "datagram-gap", dataType: 1 });
  });

  it("reassembles video independently of an interleaved control frame", () => {
    const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
    const target = session as unknown as {
      onData: (message: Buffer, address: { host: string; port: number }) => void;
      send: () => void;
    };
    target.send = vi.fn();
    const received: P2PFrame[] = [];
    session.on("data", (frame) => received.push(frame));
    const address = { host: "127.0.0.1", port: 1 };
    const videoPayload = Buffer.alloc(48, 7);
    const video = Buffer.concat([
      buildCommandHeader(50, 1300, P2PDataTypeHeader.VIDEO).subarray(4),
      buildRawCommandPayload(videoPayload).subarray(0),
    ]);
    const controlPayload = Buffer.from([1, 2, 3]);
    const control = Buffer.concat([
      buildCommandHeader(7, 1351, P2PDataTypeHeader.CONTROL).subarray(4),
      buildRawCommandPayload(controlPayload),
    ]);

    target.onData(dataPacket(50, video.subarray(0, 24)), address);
    target.onData(dataPacket(7, control, P2PDataTypeHeader.CONTROL), address);
    target.onData(dataPacket(51, video.subarray(24)), address);

    expect(received.map(({ commandId }) => commandId)).toEqual([1351, 1300]);
    expect(received[1]!.raw).toEqual(videoPayload);
  });

  it("accepts an in-order continuation across sequence wraparound", () => {
    const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
    const target = session as unknown as {
      onData: (message: Buffer, address: { host: string; port: number }) => void;
      send: () => void;
    };
    target.send = vi.fn();
    const received: P2PFrame[] = [];
    session.on("data", (frame) => received.push(frame));
    const address = { host: "127.0.0.1", port: 1 };
    const payload = Buffer.alloc(48, 7);
    const frame = Buffer.concat([
      buildCommandHeader(65_535, 1300, P2PDataTypeHeader.VIDEO).subarray(4),
      buildRawCommandPayload(payload),
    ]);

    target.onData(dataPacket(65_535, frame.subarray(0, 24)), address);
    target.onData(dataPacket(0, frame.subarray(24)), address);

    expect(received).toHaveLength(1);
    expect(received[0]!.raw).toEqual(payload);
  });
});
