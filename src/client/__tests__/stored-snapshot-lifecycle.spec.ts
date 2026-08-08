import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedSession, SessionStore } from "../../core/store.js";
import type { EufyDevice } from "../../core/types.js";
import type { ThumbnailCandidate } from "../../transport/push/types.js";
import { LoginStatus, type LoginResult } from "../../transport/http/mega-client.js";
import { EufyMega } from "../eufy-mega.js";

const CAMERA_SN = "T8000P0000000001";
const UNKNOWN_SN = "T8000P0000000002";
const NO_SNAPSHOT_SN = "T8000P0000000003";
const IMAGE_URL = "https://security-app.eufylife.com/media/thumbnail.jpg";

function session(userId = "synthetic-user"): PersistedSession {
  return {
    userId,
    authToken: "synthetic-token",
    region: "us-pr",
    openudid: "0000000000000000",
    shareKey: "00000000000000000000000000000000",
    keyIdent: "synthetic-key",
    tokenExpiresAt: 0,
    savedAt: 0,
  };
}

function sessionStore(userId = "synthetic-user"): SessionStore {
  let retained: PersistedSession | null = session(userId);
  return {
    load: () => retained,
    save: (next) => (retained = next),
    clear: () => (retained = null),
  };
}

function jpeg(body = "image"): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from(body), 0xff, 0xd9]);
}

function cameraRecord(sn = CAMERA_SN): EufyDevice {
  return {
    sn,
    model: "T8170",
    category: "eufy_security",
    realtime: "p2p",
    params: {},
    paramUpdatedAt: {},
    raw: {
      device_sn: sn,
      device_model: "T8170",
      device_type: 30,
      station_sn: sn,
      p2p_did: "XXXXXXX-000000-XXXXX",
    },
  } as EufyDevice;
}

type ClientInternals = {
  mega: {
    downloadMedia(url: string): Promise<Buffer>;
    login(): Promise<LoginResult>;
  };
  registry: {
    list(): EufyDevice[];
    record(sn: string): Promise<{
      deviceType: number;
      model: string;
      category: string;
      params: Record<number, string>;
      paramUpdatedAt: Record<number, number>;
    }>;
    require(sn: string): EufyDevice;
    capabilitiesForDevice(sn: string): ReadonlySet<string> | undefined;
  };
  observeStoredImage(candidate: ThumbnailCandidate): Promise<void>;
};

function makeClient(storedSnapshotCache?: boolean) {
  const eufy = new EufyMega({
    email: "user@example.invalid",
    password: "unused",
    store: sessionStore(),
    autoRealtime: false,
    ...(storedSnapshotCache === undefined ? {} : { storedSnapshotCache }),
  });
  const internals = eufy as unknown as ClientInternals;
  const camera = cameraRecord();
  const noSnapshot = cameraRecord(NO_SNAPSHOT_SN);

  vi.spyOn(internals.registry, "list").mockReturnValue([camera, noSnapshot]);
  vi.spyOn(internals.registry, "record").mockResolvedValue({
    deviceType: 30,
    model: "T8170",
    category: "eufy_security",
    params: {},
    paramUpdatedAt: {},
  });
  vi.spyOn(internals.registry, "require").mockImplementation((sn) => {
    if (sn === CAMERA_SN) return camera;
    if (sn === NO_SNAPSHOT_SN) return noSnapshot;
    throw new Error(`unknown test device ${sn}`);
  });
  vi.spyOn(internals.registry, "capabilitiesForDevice").mockImplementation((sn) => {
    if (sn === CAMERA_SN) return new Set(["camera", "snapshot"]);
    if (sn === NO_SNAPSHOT_SN) return new Set(["camera"]);
    return undefined;
  });
  const download = vi.spyOn(internals.mega, "downloadMedia");
  return { eufy, internals, download };
}

function exactCandidate(deviceSn = CAMERA_SN): ThumbnailCandidate {
  return { url: IMAGE_URL, attribution: { kind: "device", deviceSn } };
}

async function storedSnapshotAction(eufy: EufyMega) {
  const camera = (await eufy.getDevice(CAMERA_SN)).camera?.();
  expect(camera?.snapshotStored).toBeTypeOf("function");
  return camera!.snapshotStored!;
}

async function retainImage(client: ReturnType<typeof makeClient>, image = jpeg()) {
  client.download.mockResolvedValue(image);
  const action = await storedSnapshotAction(client.eufy);
  await client.internals.observeStoredImage(exactCandidate());
  await vi.waitFor(async () => expect(action()).resolves.toEqual(image));
  return action;
}

describe("stored snapshot client lifecycle", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("binds snapshotStored by default on a camera with snapshot evidence", async () => {
    const { eufy } = makeClient();

    const camera = (await eufy.getDevice(CAMERA_SN)).camera?.();

    expect(camera?.snapshotStored).toBeTypeOf("function");
  });

  it("storedSnapshotCache:false omits snapshotStored and ignores push candidates", async () => {
    const { eufy, internals, download } = makeClient(false);

    const camera = (await eufy.getDevice(CAMERA_SN)).camera?.();
    await internals.observeStoredImage(exactCandidate());

    expect(camera?.snapshotStored).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
  });

  it("eagerly downloads an exact eligible candidate while snapshotStored remains passive", async () => {
    const client = makeClient();
    const image = jpeg("eager");
    client.download.mockResolvedValue(image);
    const action = await storedSnapshotAction(client.eufy);

    await client.internals.observeStoredImage(exactCandidate());

    expect(client.download).toHaveBeenCalledOnce();
    expect(client.download).toHaveBeenCalledWith(IMAGE_URL);
    await vi.waitFor(async () => expect(action()).resolves.toEqual(image));
    await expect(action()).resolves.toBe(image);
    expect(client.download).toHaveBeenCalledOnce();
  });

  it.each([
    ["ambiguous", { url: IMAGE_URL, attribution: { kind: "ambiguous" } }],
    ["station-attributed", { url: IMAGE_URL, attribution: { kind: "station", stationSn: CAMERA_SN } }],
    ["unknown-device", exactCandidate(UNKNOWN_SN)],
    ["device without snapshot evidence", exactCandidate(NO_SNAPSHOT_SN)],
  ] satisfies Array<[string, ThumbnailCandidate]>)("discards a %s candidate", async (_label, candidate) => {
    const { internals, download } = makeClient();

    await internals.observeStoredImage(candidate);

    expect(download).not.toHaveBeenCalled();
  });

  it("clearSession clears retained bytes and makes a stale bound action require login", async () => {
    const client = makeClient();
    const action = await retainImage(client);

    client.eufy.clearSession();

    await expect(action()).rejects.toThrow("login() first");
  });

  it("logout clears retained bytes and makes a stale bound action require login", async () => {
    const client = makeClient();
    const action = await retainImage(client);

    await client.eufy.logout();

    await expect(action()).rejects.toThrow("login() first");
  });

  it("a successful login for a replacement account clears retained bytes", async () => {
    const client = makeClient();
    await client.eufy.login();
    const action = await retainImage(client, jpeg("first-account"));
    vi.spyOn(client.internals.mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "replacement-user", authToken: "replacement-token", raw: {} },
    });

    await client.eufy.login();

    await expect(action()).rejects.toMatchObject({ reason: "not-observed" });
  });
});
