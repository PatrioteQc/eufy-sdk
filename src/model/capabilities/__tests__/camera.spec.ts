import { CAMERA, CAMERA_CMD, Watermark, NightVision, VideoQuality, resolveVideoQuality } from "../camera.js";
import type { VideoQualityName } from "../camera.js";
import { buildCommand } from "../index.js";
import { actionSpecOf } from "../access.js";
import { bind } from "./bind.js";
import type { CameraActions } from "../camera.js";
import { DeviceType } from "../../device-types.js";
import { Device } from "../../device.js";
import type { CommandContext } from "../types.js";
import type { Command, MediaProvider } from "../../../core/contracts.js";

/**
 * Pinned to the `camera` capability so intent resolution is this module's alone — the barrel walks every
 * module a device HAS, and the spec is about what camera answers, not about resolution order.
 */
const ctx = (channel = 0, extra: Partial<CommandContext> = {}): CommandContext => ({
  channel,
  codec: "camera",
  paramIds: new Set<number>(),
  capabilities: new Set(["camera"]),
  ...extra,
});

/** The bound `dev.camera()` object — the members derive their setters in the barrel, not in `actions()`. */
const camera = (c: CommandContext, media?: MediaProvider) => bind<CameraActions>("camera", c, { media });

describe("camera capability module", () => {
  it("declares the capability + schema", () => {
    expect(CAMERA.capability).toBe("camera");
    expect(CAMERA.properties.map((p) => p.name)).toEqual([
      "enabled",
      "imageFlipped",
      "watermark",
      "nightVision",
      "videoQuality",
      "antiTheftDetection",
    ]);
  });

  describe("antiTheftDetection (1015)", () => {
    // The app parses EAS_SWITCH as anti_theft_detection_switch, so the property is named for that.
    // Adaptive scalar form (topology picks the level), and the write is evidence-gated on 1015.
    const withParam = (ch: number) => ctx(ch, { paramIds: new Set([CAMERA_CMD.EAS_SWITCH]) });

    it("emits an adaptive scalar when the device reports 1015", () => {
      expect(buildCommand("antiTheftDetection", true, withParam(3))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.EAS_SWITCH, // 1015
        value: 1,
        form: "auto",
        channel: 3,
      });
      expect(buildCommand("antiTheftDetection", false, withParam(3))).toMatchObject({ value: 0 });
    });

    it("is gated: no command on a device that doesn't report 1015 (→ not-supported, not a silent no-op)", () => {
      expect(buildCommand("antiTheftDetection", true, ctx(3))).toBeUndefined();
    });

    it("the derived setter dispatches the identical frame the intent path builds", async () => {
      const { acts, sent } = camera(withParam(3));
      await acts.setAntiTheftDetection!(true);
      expect(sent).toEqual([buildCommand("antiTheftDetection", true, withParam(3))]);
    });

    it("the setter is absent — not a rejecting stub — on a device that never reported 1015", () => {
      expect(camera(ctx(3)).acts.setAntiTheftDetection).toBeUndefined();
    });
  });

  it("is a camera-codec baseline", () => {
    expect(CAMERA.detection?.codecs).toEqual(["camera"]);
  });

  describe("buildCommand — emits transport-neutral intents (wire chosen by the resolver)", () => {
    it("on/off → a set-param 'auto' scalar for CAMERA_ENABLE (wire decided downstream)", () => {
      expect(buildCommand("on", true, ctx(1))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.CAMERA_ENABLE,
        value: 0, // default family (no deviceType) = disable bit → ON ⇒ 0
        form: "auto",
        channel: 1,
      });
      expect(buildCommand("off", false, ctx())).toMatchObject({ kind: "set-param", value: 1 });
    });

    it("privacy → the multi-frame burst command", () => {
      expect(buildCommand("privacy", true, ctx(2))).toEqual({
        kind: "p2p-privacy-burst",
        enabled: true,
        channel: 2,
      });
    });

    it("returns undefined for an unknown action", () => {
      expect(buildCommand("nope", 1, ctx())).toBeUndefined();
    });

    it("'enabled' (the canonical writable property name) reaches a set-param intent", () => {
      // Regression: the sole writable PropertySpec is named "enabled"; setProperty(sn,"enabled",…)
      // must reach a command, not fall through to CapabilityNotSupportedError.
      expect(buildCommand("enabled", true, ctx())).toMatchObject({
        kind: "set-param",
        param: CAMERA_CMD.CAMERA_ENABLE,
        value: 0,
      });
      expect(buildCommand("enabled", false, ctx())).toMatchObject({ value: 1 });
    });

    it("coerces string/number truthiness consistently (asBool) for the property path", () => {
      expect(buildCommand("enabled", "1", ctx())).toMatchObject({ value: 0 }); // ON
      expect(buildCommand("enabled", "false", ctx())).toMatchObject({ value: 1 }); // OFF
    });

    it("statusLed → a set-param pinned to int-string (DEV_LED_SWITCH 1045, always level-1)", () => {
      expect(buildCommand("statusLed", true, ctx(1))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.DEV_LED_SWITCH,
        value: 1,
        form: "int-string",
        channel: 1,
      });
      expect(buildCommand("statusLed", false, ctx())).toMatchObject({ form: "int-string", value: 0 });
    });

    it("imageFlipped → an 'auto' scalar for ROTATE_IMAGE (1207), 1=flipped/0=normal", () => {
      expect(buildCommand("imageFlipped", true, ctx(2))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.ROTATE_IMAGE,
        value: 1,
        form: "auto",
        channel: 2,
      });
      expect(buildCommand("imageFlipped", false, ctx())).toMatchObject({ value: 0 });
    });

    it("watermark → an 'auto' direct scalar for CMD_SET_DEVS_OSD (1214), Watermark enum (verified)", () => {
      // Watermark = { Off:0, Timestamp:1, TimestampAndLogo:2 } — verified live on T8425.
      expect(Watermark).toEqual({ Off: 0, Timestamp: 1, TimestampAndLogo: 2 });
      expect(buildCommand("watermark", Watermark.TimestampAndLogo, ctx(3))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.SET_DEVS_OSD,
        value: 2,
        form: "auto",
        channel: 3,
      });
      expect(buildCommand("watermark", Watermark.Off, ctx())).toMatchObject({ value: 0 });
    });

    it("watermark / nightVision throw on a value outside the enum (no bogus level on the wire)", () => {
      for (const bad of [5, -1, 99, "x"]) {
        expect(() => buildCommand("watermark", bad as number, ctx())).toThrow(
          /watermark: .+ is not a valid value \(must be one of 0\/1\/2\)/,
        );
        expect(() => buildCommand("nightVision", bad as number, ctx())).toThrow(
          /nightVision: .+ is not a valid value \(must be one of 0\/1\/2\)/,
        );
      }
      // Valid enum values still pass.
      expect(buildCommand("watermark", 1, ctx())).toMatchObject({ value: 1 });
      expect(buildCommand("nightVision", 1, ctx())).toMatchObject({ payload: { night_sion: 1 } });
    });

    it("nightVision → 1350 set-payload, mChannel 0, {channel,night_sion} (verified)", () => {
      // Verified live: device channel goes INSIDE the payload; the envelope's mChannel is 0.
      expect(NightVision).toEqual({ Off: 0, Infrared: 1, FullColor: 2 });
      expect(buildCommand("nightVision", NightVision.FullColor, ctx(3))).toMatchObject({
        kind: "set-payload",
        cmd: CAMERA_CMD.NIGHT_VISION_TYPE,
        payload: { channel: 3, night_sion: 2 },
        channel: 0,
        mValue3: 0,
      });
    });

    it("videoQuality → 1350 set-payload (2731), raw tier or resolution NAME (verified T8425)", () => {
      // Raw tier value.
      expect(buildCommand("videoQuality", 3, ctx(3))).toMatchObject({
        kind: "set-payload",
        cmd: CAMERA_CMD.VIDEO_QUALITY_SET,
        payload: { channel: 0, mode: 0, primary_view: 0, quality: 3 },
        channel: 3,
        mValue3: 0,
      });
      // Resolution NAME → tier (verified live on T8425): 1=720P, 2=1080P, 3=3K HD.
      expect(resolveVideoQuality(1)).toBe("HD (720P)");
      expect(resolveVideoQuality(3)).toBe("3K HD");
      const byName = buildCommand("videoQuality", VideoQuality.HD720, ctx(3));
      expect(byName).toMatchObject({ cmd: CAMERA_CMD.VIDEO_QUALITY_SET, payload: { quality: 1 } });
    });

    it("videoQuality throws on a value that isn't a real tier (no bogus value on the fire-and-forget wire)", () => {
      const c = ctx(3); // verified tiers = 1/2/3
      // Out-of-range raw values must NOT produce a command (0 / negative / above top tier / non-tier name).
      for (const bad of [0, -1, 99, "0", "4K HD"]) {
        expect(() => buildCommand("videoQuality", bad, c)).toThrow(
          /videoQuality: .+ is not a valid value \(must be one of 1\/2\/3\)/,
        );
      }
      // Valid tiers still pass.
      expect(buildCommand("videoQuality", 2, c)).toMatchObject({ payload: { quality: 2 } });
    });

    /**
     * The member renames its argument (`quality`, not `videoQuality`) and explains what it takes, while
     * the tier set is DERIVED from `decodedValues`. A member's own arg used to REPLACE the derived one, so
     * the rename silently dropped the tiers and left a caller rendering a picker with nothing to pick.
     */
    it("videoQuality's described argument keeps the derived tier set under its own name", () => {
      const { acts } = camera(ctx(3, { paramIds: new Set([CAMERA_CMD.VIDEO_QUALITY_SET]) }));
      const spec = actionSpecOf(acts.setVideoQuality)!;
      expect(spec.args).toEqual([
        {
          name: "quality",
          kind: "enum",
          values: [1, 2, 3],
          description: "A tier; the resolution name it maps to is accepted too.",
        },
      ]);
    });

    it("statusLed on a DOORBELL swaps to the 1716 set-payload wire (family-aware, verified T8214)", () => {
      const doorbellCtx = ctx(3, { deviceType: 94, model: "T8214", capabilities: new Set(["camera", "doorbell"]) });
      expect(buildCommand("statusLed", true, doorbellCtx)).toEqual({
        kind: "set-payload",
        cmd: CAMERA_CMD.DOORBELL_LED,
        payload: { light_enable: 1 },
        channel: 3,
      });
      expect(buildCommand("statusLed", false, doorbellCtx)).toMatchObject({
        kind: "set-payload",
        payload: { light_enable: 0 },
      });
    });

    it("the doorbell's writable `doorbellLedEnable` property routes through the same status-LED wire", () => {
      const doorbellCtx = ctx(3, { deviceType: 94, model: "T8214", capabilities: new Set(["camera", "doorbell"]) });
      expect(buildCommand("doorbellLedEnable", true, doorbellCtx)).toMatchObject({
        kind: "set-payload",
        cmd: CAMERA_CMD.DOORBELL_LED,
        payload: { light_enable: 1 },
      });
    });
  });

  describe("power — polarity is the capability's concern (family-dependent value)", () => {
    // The capability owns POLARITY (the value); the WIRE (int-string vs direct-binary) is the
    // resolver's job — see resolver.spec / index. So here we assert value + form only.
    it("default / battery family (T8114, type 9): disable bit → ON ⇒ 0, form auto", () => {
      expect(buildCommand("on", true, ctx(0, { deviceType: 9, model: "T8114" }))).toMatchObject({
        kind: "set-param",
        form: "auto",
        value: 0,
      });
      expect(buildCommand("off", false, ctx(0, { deviceType: 9, model: "T8114" }))).toMatchObject({ value: 1 });
    });

    it("indoor-PT T8410 (type 31): enable bit → ON ⇒ 1, OFF ⇒ 0", () => {
      expect(buildCommand("on", true, ctx(0, { deviceType: 31, model: "T8410" }))).toMatchObject({ value: 1 });
      expect(buildCommand("off", false, ctx(0, { deviceType: 31, model: "T8410" }))).toMatchObject({
        value: 0,
      });
    });

    it("floodlight cams 8422/8424 flip to enable bit → ON ⇒ 1", () => {
      expect(buildCommand("on", true, ctx(0, { deviceType: 37, model: "T8422" }))).toMatchObject({ value: 1 });
      expect(buildCommand("on", true, ctx(0, { deviceType: 39, model: "T8424" }))).toMatchObject({ value: 1 });
    });

    it("battery/solo family (default) stays disable bit → ON ⇒ 0", () => {
      expect(buildCommand("on", true, ctx(0, { deviceType: 9, model: "T8114" }))).toMatchObject({ value: 0 });
    });

    it("mini / S350 / outdoor-PT power → the 6250 privacy burst, INVERTED (V6 HUB wire, not 1035)", () => {
      // These families ride COMMAND_APP_PRIVACY (6250) inverted, per the V6 CameraOnOffParser:
      // power-on = privacy-off. DeviceType.INDOOR_COST_DOWN_CAMERA (mini), INDOOR_PT_CAMERA_S350,
      // OUTDOOR_PT_CAMERA. The privacy burst is level-2, so a standalone one throws downstream (no key).
      expect(buildCommand("on", true, ctx(2, { deviceType: DeviceType.INDOOR_COST_DOWN_CAMERA }))).toEqual({
        kind: "p2p-privacy-burst",
        enabled: false, // power-on ⇒ privacy-off (inverted)
        channel: 2,
      });
      expect(buildCommand("on", true, ctx(0, { deviceType: DeviceType.INDOOR_PT_CAMERA_S350 }))).toMatchObject({
        kind: "p2p-privacy-burst",
        enabled: false,
      });
      expect(buildCommand("off", false, ctx(0, { deviceType: DeviceType.OUTDOOR_PT_CAMERA }))).toMatchObject({
        kind: "p2p-privacy-burst",
        enabled: true, // power-off ⇒ privacy-on
      });
    });
  });

  describe("enabled — family-aware read (param + polarity)", () => {
    // Battery/solo cam reports on/off under 1035 (disable bit → "0" ⇒ ON). Verified live: T8114.
    it('1035="0" reads enabled=true (inverted disable bit)', () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 9,
        model: "T8114",
        category: "eufy_security",
        params: { 1035: "0" },
      });
      expect(dev.getProperty("enabled")?.value).toBe(true);
    });
    it('1035="1" reads enabled=false', () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 9,
        model: "T8114",
        category: "eufy_security",
        params: { 1035: "1" },
      });
      expect(dev.getProperty("enabled")?.value).toBe(false);
    });
    // Standalone indoor cam reports on/off under 2001 OPEN_DEVICE (direct polarity). Verified live: T8410.
    it('2001="false" reads enabled=false (OPEN_DEVICE alias, direct polarity)', () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 31,
        model: "T8410",
        category: "eufy_security",
        params: { 2001: "false" },
      });
      expect(dev.getProperty("enabled")?.value).toBe(false);
    });
    it('2001="true" reads enabled=true', () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 31,
        model: "T8410",
        category: "eufy_security",
        params: { 2001: "true" },
      });
      expect(dev.getProperty("enabled")?.value).toBe(true);
    });
  });

  describe("actions", () => {
    it("on/off dispatch inverted power; setPrivacy dispatches the burst", async () => {
      const { acts, sent } = camera(ctx(0));
      await acts.on();
      await acts.off();
      await acts.setPrivacy(true);
      expect(sent[0]).toMatchObject({ kind: "set-param", form: "auto", value: 0 }); // ON = 0 (default family)
      expect(sent[1]).toMatchObject({ kind: "set-param", form: "auto", value: 1 }); // OFF = 1
      expect(sent[2]).toMatchObject({ kind: "p2p-privacy-burst", enabled: true });
    });

    it("a derived setter dispatches its member's command; a value the member rejects never reaches the wire", async () => {
      const { acts, sent } = camera(ctx(3));
      await acts.setWatermark(2);
      await acts.setVideoQuality(3);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({ param: CAMERA_CMD.SET_DEVS_OSD, value: 2 });
      expect(sent[1]).toMatchObject({ cmd: CAMERA_CMD.VIDEO_QUALITY_SET, payload: { quality: 3 } });
      await expect(acts.setWatermark(5)).rejects.toThrow("watermark: 5 is not a valid value (must be one of 0/1/2)");
      await expect(acts.setNightVision(9)).rejects.toThrow(
        "nightVision: 9 is not a valid value (must be one of 0/1/2)",
      );
      await expect(acts.setVideoQuality(0)).rejects.toThrow(
        "videoQuality: 0 is not a valid value (must be one of 1/2/3)",
      );
      expect(sent).toHaveLength(2);
    });

    it("media actions appear only with a provider, and delegate to it", async () => {
      expect(camera(ctx()).acts.snapshot).toBeUndefined(); // controls only when unbound to media

      const calls: string[] = [];
      const media: MediaProvider = {
        snapshot: async () => (calls.push("snapshot"), { file: "f", jpeg: Buffer.alloc(0) }),
        snapshotLive: async () => (calls.push("snapshotLive"), { jpeg: Buffer.alloc(0), width: 1, height: 1 }),
        // The test only checks it's callable; a live stream instance isn't needed here.
        live: async () => (calls.push("live"), {} as never),
        record: async (s: number) => (calls.push(`record:${s}`), Buffer.alloc(0)),
      };
      const { acts } = camera(ctx(), media);
      const snap = await acts.snapshot!();
      await acts.record!(5);
      expect(snap).toMatchObject({ file: "f" });
      expect(calls).toEqual(["snapshot", "record:5"]);
    });

    it("an optional media method the provider does not implement is absent, not a key holding undefined", () => {
      const media: MediaProvider = {
        snapshot: async () => ({ file: "", jpeg: Buffer.alloc(0) }),
        snapshotLive: async () => ({ jpeg: Buffer.alloc(0), width: 1, height: 1 }),
        live: async () => ({}) as never,
        record: async () => Buffer.alloc(0),
      };
      expect("openReadable" in camera(ctx(), media).acts).toBe(false);
    });
  });

  /**
   * Talkback is a speaker feature, so it is gated on the SPEAKER param being reported — not on the
   * `audio` capability, which resolves on a microphone alone. A mic-only camera advertising talkback is
   * exactly the phantom sub-feature evidence-gating exists to prevent.
   */
  describe("talkback gating", () => {
    const AUDIO_MICROPHONE = 1240;
    const AUDIO_SPEAKER = 1241;

    const mediaWithTalkback = (calls: string[] = []): MediaProvider => ({
      snapshot: async () => ({ file: "", jpeg: Buffer.alloc(0) }),
      snapshotLive: async () => ({ jpeg: Buffer.alloc(0), width: 1, height: 1 }),
      live: async () => ({}) as never,
      record: async () => Buffer.alloc(0),
      talkback: async (opts) => (calls.push(`talkback:${opts?.powered}`), {}) as never,
    });

    it("is offered when the device reported a speaker", () => {
      const { acts } = camera(ctx(0, { paramIds: new Set([AUDIO_SPEAKER]) }), mediaWithTalkback());
      expect(acts.talkback).toBeTypeOf("function");
    });

    it("is withheld from a camera that reported only a microphone", () => {
      const { acts } = camera(ctx(0, { paramIds: new Set([AUDIO_MICROPHONE]) }), mediaWithTalkback());
      expect(acts.talkback).toBeUndefined();
    });

    it("is withheld when the device reported neither", () => {
      expect(camera(ctx(), mediaWithTalkback()).acts.talkback).toBeUndefined();
    });

    it("carries the power hint, so a battery camera talked to is still bounded", async () => {
      const calls: string[] = [];
      const { acts } = camera(
        ctx(0, { paramIds: new Set([AUDIO_SPEAKER]), capabilities: new Set(["camera", "battery"]) }),
        mediaWithTalkback(calls),
      );
      await acts.talkback!();
      expect(calls).toEqual(["talkback:battery"]);
    });

    it("passes the power hint to both snapshot paths, which can be what warms the session", async () => {
      const seen: string[] = [];
      const media: MediaProvider = {
        snapshot: async (o) => (seen.push(`snapshot:${o?.powered}`), { file: "", jpeg: Buffer.alloc(0) }),
        snapshotLive: async (o) => (
          seen.push(`snapshotLive:${o?.powered}`),
          { jpeg: Buffer.alloc(0), width: 1, height: 1 }
        ),
        live: async () => ({}) as never,
        record: async () => Buffer.alloc(0),
      };
      const { acts } = camera(ctx(0, { capabilities: new Set(["camera", "battery"]) }), media);
      await acts.snapshot!();
      await acts.snapshotLive!();
      expect(seen).toEqual(["snapshot:battery", "snapshotLive:battery"]);
    });
  });
});

/**
 * The derived surface, pinned at COMPILE time — these assertions have no runtime half, which is the
 * point: what a developer sees in the editor is the same table the runtime installs from, and the two
 * cannot drift. Checked by `npm run typecheck`; a widened type fails the build here.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const cam: CameraActions;

// A getter is optional (evidence-gated) and narrowed to what the member declares it is stored as.
const _enabled: Exact<typeof cam.enabled, boolean | undefined> = true;
const _watermark: Exact<typeof cam.watermark, number | undefined> = true;

// Write-only: a setter, and NO getter — the device never reports either state back.
const _noPrivacyGetter: Exact<"privacy" extends keyof CameraActions ? true : false, false> = true;
const _noStatusLedGetter: Exact<"statusLed" extends keyof CameraActions ? true : false, false> = true;
const _setPrivacy: Exact<Parameters<typeof cam.setPrivacy>[0], boolean> = true;

// `accepts` widens the SETTER past the getter: a resolution name as well as the tier that is stored.
const _videoQualityRead: Exact<typeof cam.videoQuality, number | undefined> = true;
const _videoQualityWrite: Exact<Parameters<NonNullable<typeof cam.setVideoQuality>>[0], VideoQualityName | number> =
  true;

// An evidence-gated write is OPTIONAL, so a caller is made to check; an ungated one is not.
const _antiTheftOptional: Exact<undefined extends typeof cam.setAntiTheftDetection ? true : false, true> = true;
const _watermarkRequired: Exact<undefined extends typeof cam.setWatermark ? true : false, false> = true;

// Media is optional (absent unbound) and typed BY the provider — `snapshot` answers its return, not void.
const _snapshotOptional: Exact<undefined extends typeof cam.snapshot ? true : false, true> = true;
const _snapshotReturns: Exact<
  ReturnType<NonNullable<typeof cam.snapshot>>,
  ReturnType<MediaProvider["snapshot"]>
> = true;
const _recordArg: Exact<Parameters<NonNullable<typeof cam.record>>[0], number> = true;
// …and a builder's falsy "declined" answer never reaches the caller — past the guard it is the function.
const _talkbackNotFalse: Exact<false extends typeof cam.talkback ? true : false, false> = true;

export const _surfaceAssertions = [
  _enabled,
  _watermark,
  _noPrivacyGetter,
  _noStatusLedGetter,
  _setPrivacy,
  _videoQualityRead,
  _videoQualityWrite,
  _antiTheftOptional,
  _watermarkRequired,
  _snapshotOptional,
  _snapshotReturns,
  _recordArg,
  _talkbackNotFalse,
];
