import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAckPayload,
  decryptP2PData,
  frameMessage,
  parseDataFrameHeader,
  p2pCommandEncryptionKey,
  P2PDataTypeHeader,
  ResponseMessageType,
} from "../codec.js";
import { P2PSession } from "../p2p-session.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

describe("live start acknowledgement diagnostics", () => {
  afterEach(() => vi.useRealTimers());

  it("reports when the camera acknowledges an own-session live start", () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      logger,
    });
    const send = vi.fn();
    const target = session as unknown as {
      connectAddress: { host: string; port: number };
      send: typeof send;
      onAck: (message: Buffer) => void;
    };
    target.connectAddress = { host: "127.0.0.1", port: 1 };
    target.send = send;

    session.startLiveMedia();
    target.onAck(frameMessage(ResponseMessageType.ACK, buildAckPayload(P2PDataTypeHeader.DATA, 0)));

    expect(logger.debug).toHaveBeenCalledWith("[live] start trace", {
      phase: "media-command-ack",
      action: "start",
    });
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses the current app's own-session START_LIVE fields", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      logger,
    });
    const send = vi.fn();
    const target = session as unknown as {
      connectAddress: { host: string; port: number };
      send: typeof send;
    };
    target.connectAddress = { host: "127.0.0.1", port: 1 };
    target.send = send;

    session.startLiveMedia(0, "0000000000000000000000000000000000000000");
    const data = send.mock.calls[0]![2] as Buffer;
    const header = parseDataFrameHeader(data.subarray(4));
    const encrypted = data.subarray(20, 20 + header.bytesToRead);
    const value = JSON.parse(
      decryptP2PData(encrypted, Buffer.from(p2pCommandEncryptionKey(STATION_SN, P2P_DID)))
        .toString("utf8")
        .replace(/\0+$/, ""),
    );

    expect(value.data).toMatchObject({ msg_id: 1, extValue: 1000 });
  });

  it("retransmits one unacknowledged live start with the same sequence", () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, logger });
    const send = vi.fn();
    const target = session as unknown as {
      connectAddress: { host: string; port: number };
      send: typeof send;
    };
    target.connectAddress = { host: "127.0.0.1", port: 1 };
    target.send = send;

    session.startLiveMedia();
    const first = send.mock.calls[0]![2] as Buffer;
    vi.advanceTimersByTime(500);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![2]).toEqual(first);
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith("[live] start trace", {
      phase: "media-command-unacknowledged",
      action: "start",
    });
  });
});
