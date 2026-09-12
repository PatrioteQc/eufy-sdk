import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EufyDevice } from "../../core/types.js";

/**
 * The client id the long-lived secure-MQTT transports connect under.
 *
 * The certificate's own name (`thing_name` = `{user_id}-{app_name}`) identifies the ACCOUNT and the
 * line, not the install, and the broker resolves a duplicate client id by evicting the incumbent — so
 * two clients on one account flap indefinitely, neither holding a channel. These specs pin the id to
 * this install and pin the fallback that keeps a credential whose policy refuses that id connected.
 *
 * `SecureMqtt` is mocked (no sockets, no cloud); `buildAppShapedClientId` and `mqttUuidFrom` stay real
 * — they are pure, and what they produce is exactly what is under test.
 */
const connect = vi.fn().mockResolvedValue(undefined);
const constructedWith: any[] = [];
vi.mock("../../transport/mqtt/secure-mqtt.js", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSecureMqtt extends EventEmitter {
    constructor(opts: any) {
      super();
      constructedWith.push(opts);
    }
    connect = connect;
  }
  return { SecureMqtt: FakeSecureMqtt };
});

const { EufyMega } = await import("../eufy-mega.js");

/** A synthetic account id of the right shape — 40 hex, as the cloud issues them. */
const UID = "0".repeat(40);

const CREDS = {
  endpoint_addr: "aiot-mqtt-eu.anker.com",
  endpoint_port: 8883,
  certificate_pem: "CERT",
  private_key: "KEY",
  aws_root_ca1_pem: "CA",
  thing_name: `${UID}-eufy_mega`,
  user_id: UID,
};

/** A client signed in far enough to bring one MQTT scope up, with no network behind it. */
function makeClient(openudid: string, creds: Record<string, unknown> = CREDS) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", openudid });
  Object.defineProperty((eufy as any).mega, "auth", {
    configurable: true,
    get: () => ({ userId: UID, authToken: "t" }),
  });
  const dev = { sn: "T8000P0000000000", category: "eufy_mega" } as unknown as EufyDevice;
  vi.spyOn((eufy as any).registry, "list").mockReturnValue([dev]);
  vi.spyOn(eufy, "getMqttDevices").mockReturnValue([]);
  vi.spyOn(eufy, "getUserMqttInfo").mockResolvedValue(creds as never);
  return eufy;
}

const start = (eufy: any, scope = "default") => eufy.startMqtt(scope);

describe("secure-MQTT client id", () => {
  beforeEach(() => {
    constructedWith.length = 0;
    connect.mockReset().mockResolvedValue(undefined);
  });

  it("identifies the install, not the certificate", async () => {
    await start(makeClient("a".repeat(16)));

    expect(constructedWith).toHaveLength(1);
    const id: string = constructedWith[0].clientId;
    expect(id).toMatch(new RegExp(`^android-eufy_mega-${UID}-[0-9a-f]{16}-\\d+$`));
    expect(id).not.toContain(CREDS.thing_name);
  });

  it("is stable for one install and different for another", async () => {
    await start(makeClient("a".repeat(16)));
    await start(makeClient("a".repeat(16)));
    await start(makeClient("b".repeat(16)));

    const uuid = (i: number) => String(constructedWith[i].clientId).split("-")[3];
    expect(uuid(0)).toBe(uuid(1));
    expect(uuid(2)).not.toBe(uuid(0));
  });

  it("keeps one install's two credential scopes apart", async () => {
    const eufy = makeClient("a".repeat(16));
    await start(eufy, "default");
    vi.spyOn(eufy, "getUserMqttInfo").mockResolvedValue({ ...CREDS, app_name: undefined } as never);
    await start(eufy, "eufy_life");

    expect(constructedWith[0].clientId).toContain("-eufy_mega-");
    expect(constructedWith[1].clientId).toContain("-eufy_life-");
  });

  it("follows the credential's own app name when it reports one", async () => {
    await start(makeClient("a".repeat(16), { ...CREDS, app_name: "eufy_home" }));

    expect(constructedWith[0].clientId).toContain("-eufy_home-");
  });

  it("falls back to the certificate's name when the broker refuses that id", async () => {
    connect.mockRejectedValueOnce(new Error("Connection refused: Not authorized")).mockResolvedValue(undefined);

    await start(makeClient("a".repeat(16)));

    expect(constructedWith).toHaveLength(2);
    expect(constructedWith[0].clientId).toMatch(/^android-/);
    expect(constructedWith[1].clientId).toBeUndefined();
  });

  it("does not remember the fallback — the next bring-up asks under the install's id again", async () => {
    const eufy = makeClient("a".repeat(16));
    connect.mockRejectedValueOnce(new Error("Connection refused: Not authorized")).mockResolvedValue(undefined);
    await start(eufy);
    constructedWith.length = 0;

    await start(eufy);

    expect(constructedWith[0].clientId).toMatch(/^android-/);
  });

  it("reports a connect that fails under both ids rather than returning a dead transport", async () => {
    connect.mockRejectedValue(new Error("ECONNRESET"));

    await expect(start(makeClient("a".repeat(16)))).rejects.toThrow("ECONNRESET");
    expect(constructedWith).toHaveLength(2);
  });
});
