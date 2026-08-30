import { describe, expect, it } from "vitest";
import { bind } from "./bind.js";
import type { CameraActions } from "../camera.js";
import type { CommandContext } from "../types.js";
import type { MediaProvider } from "../../../core/contracts.js";

/**
 * A camera switched off in the app cannot serve media, and says so instead of being asked.
 *
 * Eufy's own behaviour on a disabled camera is to answer a live start with AUDIO and never a video frame —
 * measured as 234 audio frames and no video across 20 s, then 217 video access units with nothing changed but
 * its own on/off state. So a caller that asks anyway does not fail: it warms for the whole window and reports
 * a `warm-timeout at audio-only`, which is indistinguishable from a camera that is broken.
 *
 * It misled this SDK's own author, who read that stage on a real fleet and reported a switched-off camera as a
 * pre-existing video defect. `enabled` is the reliable source and its own description says a live probe is not
 * one, so the refusal belongs where that reading is already held rather than in every caller that might
 * remember to check.
 *
 * A reading of `undefined` refuses nothing. Some families report neither wire param, and a camera whose state
 * is unknown is not a camera known to be off — withholding media there would break every device that simply
 * never says.
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
  it("refuses a live stream, rather than warming for twenty seconds on audio it cannot use", async () => {
    await expect(cameraWith(false).live!()).rejects.toThrow(/disabled/i);
  });

  it("refuses a live snapshot burst, which is the same pull under another name", async () => {
    await expect(cameraWith(false).snapshotLive!()).rejects.toThrow(/disabled/i);
  });

  it("still hands over the retained push thumbnail, which needs no pull at all", async () => {
    await expect(cameraWith(false).snapshotStored!()).resolves.toBeInstanceOf(Buffer);
  });
});

describe("a camera whose enabled reading is true or unknown", () => {
  it("streams when it is on", async () => {
    await expect(cameraWith(true).live!()).resolves.toBeDefined();
  });

  it("streams when its state was never reported, an unknown camera not being a known-off one", async () => {
    await expect(cameraWith(undefined).live!()).resolves.toBeDefined();
  });
});
