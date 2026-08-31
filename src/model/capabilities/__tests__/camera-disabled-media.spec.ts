import { describe, expect, it } from "vitest";
import { bind } from "./bind.js";
import type { CameraActions } from "../camera.js";
import type { CommandContext } from "../types.js";
import type { MediaProvider } from "../../../core/contracts.js";

/**
 * A camera switched off in the app serves no media, and says so rather than being asked.
 *
 * A disabled camera answers a live start with audio and never a video frame, so a pull that is attempted
 * spends its whole warm-up window and reports `warm-timeout at audio-only` — a stage this codebase documents
 * as an observation and not a diagnosis. `enabled` is the on/off source and states outright that a live probe
 * is not one, so the refusal sits where that reading is held.
 *
 * A reading of `undefined` refuses nothing: families reporting neither wire param leave the state unknown, and
 * unknown is not known-off.
 */
const ctx = (extra: Partial<CommandContext> = {}): CommandContext => ({
  channel: 0,
  codec: "camera",
  paramIds: new Set<number>(),
  capabilities: new Set(["camera", "snapshot"]),
  ...extra,
});

const media = (): MediaProvider => ({
  snapshotStored: async () => Buffer.alloc(1),
  snapshotLive: async () => ({ jpeg: Buffer.alloc(1), width: 1, height: 1 }),
  live: async () => ({}) as never,
  record: async () => Buffer.alloc(1),
});

const cameraWith = (enabled: boolean | undefined) =>
  bind<CameraActions>("camera", ctx(), {
    media: media(),
    read: (name) => (name === "enabled" ? { value: enabled } : undefined),
  }).acts;

describe("a camera whose enabled reading is false", () => {
  it("refuses a live stream", async () => {
    await expect(cameraWith(false).live!()).rejects.toThrow(/disabled/i);
  });

  it("refuses a live snapshot burst, that being the same pull under another name", async () => {
    await expect(cameraWith(false).snapshotLive!()).rejects.toThrow(/disabled/i);
  });

  it("refuses a bounded clip, which opens its own pull", async () => {
    await expect(cameraWith(false).record!(10)).rejects.toThrow(/disabled/i);
  });

  it("still hands over the retained push thumbnail, which is no pull", async () => {
    await expect(cameraWith(false).snapshotStored!()).resolves.toBeInstanceOf(Buffer);
  });
});

describe("a camera whose enabled reading is true or unknown", () => {
  it("streams when it is on", async () => {
    await expect(cameraWith(true).live!()).resolves.toBeDefined();
  });

  it("streams where the state was never reported, unknown not being known-off", async () => {
    await expect(cameraWith(undefined).live!()).resolves.toBeDefined();
  });
});
