import { P2PSession } from "../p2p-session.js";

/**
 * A control reply with no JSON body is the numeric result of the command just sent. Driven through
 * the private frame handler: the decode is what is under test, not the socket.
 */
const results = (commandId: number, body: Buffer) => {
  const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
  const seen: { code: number; channel: number }[] = [];
  session.on("commandResult", (r) => seen.push(r));
  (session as unknown as { handleFrame(h: unknown, p: Buffer, d: number): void }).handleFrame(
    { commandId, channel: 0, signCode: 0, bytesToRead: body.length },
    body,
    0,
  );
  return seen;
};

/** An int32 LE result body, as the station sends one. */
const code = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
};

describe("P2P frame — command result", () => {
  it("reads the result of a media command, sent over CMD_SET_PAYLOAD", () => {
    expect(results(1350, code(0))).toEqual([{ code: 0, channel: 0 }]);
  });

  it("reads the result of a device-control command, sent over CMD_CONTROL_PAYLOAD", () => {
    // The two wrappers answer identically, and only 1350 was read: a station refusing a control
    // command reached the caller as silence, which is also what an unanswered send looks like.
    expect(results(1700, code(-108))).toEqual([{ code: -108, channel: 0 }]);
  });

  it("carries a failure code through as it arrives, negative and unmapped", () => {
    expect(results(1350, code(-104))).toEqual([{ code: -104, channel: 0 }]);
  });

  it("reports nothing for a reply that carries a JSON document", () => {
    // A document is the answer itself; only a bodyless reply is a bare result code.
    const body = Buffer.concat([Buffer.from(JSON.stringify({ cmd: 1306, count: 0 }), "utf8"), Buffer.from([0])]);
    expect(results(1700, body)).toEqual([]);
  });

  it("reports nothing for a body too short to hold one", () => {
    expect(results(1700, Buffer.from([0, 1, 2]))).toEqual([]);
  });
});
