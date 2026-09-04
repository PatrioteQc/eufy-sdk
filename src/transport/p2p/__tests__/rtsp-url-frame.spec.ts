import { describe, expect, it, vi } from "vitest";
import {
  buildCommandHeader,
  buildRawCommandPayload,
  frameMessage,
  P2PDataTypeHeader,
  RequestMessageType,
} from "../codec.js";
import { P2PSession } from "../p2p-session.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const ADDRESS = { host: "127.0.0.1", port: 1 };
const CMD_NAS_SWITCH = 1145;

function dataPacket(sequence: number, body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  P2PDataTypeHeader.VIDEO.copy(header);
  header.writeUInt16BE(sequence, 2);
  return frameMessage(RequestMessageType.DATA, Buffer.concat([header, body]));
}

/** A whole command frame the station pushed, small enough to arrive in one datagram. */
function commandFrame(sequence: number, commandId: number, payload: Buffer): Buffer {
  return Buffer.concat([
    buildCommandHeader(sequence, commandId, P2PDataTypeHeader.VIDEO).subarray(4),
    buildRawCommandPayload(payload),
  ]);
}

function harness() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, logger });
  const target = session as unknown as { onData: (m: Buffer, a: typeof ADDRESS) => void; send: () => void };
  target.send = vi.fn();
  const urls: { channel: number; url: string }[] = [];
  session.on("rtspUrl", (ev) => urls.push(ev as { channel: number; url: string }));
  return { urls, feed: (p: Buffer) => target.onData(p, ADDRESS), close: () => session.close() };
}

describe("the RTSP URL the station pushes on CMD_NAS_SWITCH", () => {
  it("is emitted as rtspUrl with the channel and the full authoritative link", () => {
    const { urls, feed, close } = harness();
    // A NUL-terminated rtsp:// string — host, path, and the credentials the device enforces now.
    const url = "rtsp://freshuser:freshpass@192.168.0.5/live0";
    const body = Buffer.concat([Buffer.from(url, "utf8"), Buffer.from([0])]);
    feed(dataPacket(1, commandFrame(1, CMD_NAS_SWITCH, body)));
    expect(urls).toHaveLength(1);
    expect(urls[0]!.url).toBe(url);
    close();
  });

  it("ignores a CMD_NAS_SWITCH frame that carries no rtsp:// string", () => {
    const { urls, feed, close } = harness();
    const body = Buffer.concat([Buffer.from("ok", "utf8"), Buffer.from([0])]);
    feed(dataPacket(1, commandFrame(1, CMD_NAS_SWITCH, body)));
    expect(urls).toHaveLength(0);
    close();
  });
});
