import { AUDIO, AUDIO_CMD, HubAlarmTone, type AudioActions } from "../audio.js";
import { bind } from "./bind.js";
import { DeviceType } from "../../device-types.js";
import { buildCommand, detectCapabilities } from "../index.js";
import type { CommandContext } from "../types.js";
import type { Command } from "../../../core/contracts.js";

/**
 * Audio capability (offline). Asserts the WRITE intents each action emits and the detection signal.
 * The wire (`direct-binary`, signCode 8) and polarity (on ⇒ 1) are CONFIRMED on T8214 (
 * cmd 1240/1241, 136-byte struct; cloud param OFF→0/ON→1). These tests lock that behaviour.
 */
const ctx = (channel = 0, extra: Partial<CommandContext> = {}): CommandContext => ({
  channel,
  codec: "camera",
  // The barrel's `buildCommand` only lets a module answer for a capability the device HAS; these ctxs
  // hand evidence directly rather than through detection, so the resolved set is stated.
  capabilities: new Set(["audio"] as const),
  paramIds: new Set<number>(),
  ...extra,
});

describe("audio capability module", () => {
  it("declares the mic/speaker/volume schema", () => {
    expect(AUDIO.capability).toBe("audio");
    expect(AUDIO.properties.map((p) => p.name)).toEqual([
      "microphone",
      "speaker",
      "speakerVolume",
      "audioRecording",
      "hubAlarmTone",
    ]);
  });

  it("detects cameras via mic/speaker params; the HomeBase family, but NOT NVRs", () => {
    expect(detectCapabilities({ params: { 1240: "1", 1241: "1" } }, "camera")).toContain("audio");
    // A camera reporting only volume (1230) but no mic/speaker switch is NOT two-way audio.
    expect(detectCapabilities({ params: { 1230: "26" } }, "camera")).not.toContain("audio");
    // The HomeBase (HB3) has a speaker → audio; keyed on the HOMEBASE deviceType, not the codec.
    expect(detectCapabilities({ deviceType: DeviceType.HB3, params: {} }, "station")).toContain("audio");
    // An NVR (S4 Max / PoE NVR) is `station` codec but has no speaker → must NOT get audio.
    expect(detectCapabilities({ deviceType: DeviceType.NVR_S4_MAX, params: {} }, "station")).not.toContain("audio");
    expect(detectCapabilities({ deviceType: DeviceType.CAMERA_POE_S4, params: {} }, "station")).not.toContain("audio");
  });

  describe("buildCommand — direct-binary intents (wire verified live on T8214)", () => {
    it("microphone → set-param direct-binary on 1240, on ⇒ 1 / off ⇒ 0", () => {
      expect(buildCommand("microphone", true, ctx(2))).toEqual({
        kind: "set-param",
        param: AUDIO_CMD.AUDIO_MICROPHONE,
        value: 1,
        form: "direct-binary",
        channel: 2,
      });
      expect(buildCommand("microphone", false, ctx())).toMatchObject({ value: 0 });
    });

    it("speaker → set-param direct-binary on 1241", () => {
      expect(buildCommand("speaker", true, ctx())).toMatchObject({
        kind: "set-param",
        param: AUDIO_CMD.AUDIO_SPEAKER,
        value: 1,
        form: "direct-binary",
      });
    });

    it("speakerVolume/volume → set-param direct-binary on 1230, rejecting anything outside 0..100", () => {
      expect(buildCommand("speakerVolume", 80, ctx())).toMatchObject({
        param: AUDIO_CMD.SPEAKER_VOLUME,
        value: 80,
        form: "direct-binary",
      });
      expect(() => buildCommand("volume", 250, ctx())).toThrow(
        /volume: 250 is not a valid value \(must be in 0\.\.100\)/,
      );
      expect(() => buildCommand("volume", -5, ctx())).toThrow(
        /volume: -5 is not a valid value \(must be in 0\.\.100\)/,
      );
    });

    it("audioRecording → 1350 set-payload {channel, record_mute} on the device ch, INVERTED (on ⇒ mute 0)", () => {
      // Reversed from a live capture on T8425 (ch3): key is `record_mute`, inverted.
      expect(buildCommand("audioRecording", true, ctx(3))).toMatchObject({
        kind: "set-payload",
        cmd: AUDIO_CMD.AUDIO_RECORDING, // 1288
        channel: 3,
        mValue3: 0,
        payload: { channel: 3, record_mute: 0 },
      });
      expect(
        (buildCommand("audioRecording", false, ctx(3)) as Extract<Command, { kind: "set-payload" }>).payload,
      ).toEqual({ channel: 3, record_mute: 1 });
    });
    it("audioRecording property is inverted (raw 1288 = record_mute)", () => {
      const p = AUDIO.properties.find((x) => x.name === "audioRecording");
      expect(p?.paramType).toBe(AUDIO_CMD.AUDIO_RECORDING);
      expect(p?.invert).toBe(true);
    });

    it("returns undefined for an unknown action", () => {
      expect(buildCommand("nope", 1, ctx())).toBeUndefined();
    });
  });

  it("actions dispatch the same intents (camera family)", async () => {
    const { acts, sent } = bind<AudioActions>("audio", ctx(3)); // default ctx = camera codec
    await acts.setMicrophone!(false);
    await acts.setSpeaker!(true);
    await acts.setVolume!(40);
    expect(sent).toEqual([
      { kind: "set-param", param: 1240, value: 0, form: "direct-binary", channel: 3 },
      { kind: "set-param", param: 1241, value: 1, form: "direct-binary", channel: 3 },
      { kind: "set-param", param: 1230, value: 40, form: "direct-binary", channel: 3 },
    ]);
  });

  describe("station (HomeBase) audio — folded into the same capability", () => {
    const hubCtx = ctx(0, { codec: "station", deviceType: DeviceType.HB3 });

    it("a HomeBase gets alarm + prompt volume, NOT mic/speaker/ringtone", () => {
      const { acts } = bind<AudioActions>("audio", hubCtx);
      expect(acts.setAlarmVolume).toBeDefined();
      expect(acts.setPromptVolume).toBeDefined();
      expect(acts.setMicrophone).toBeUndefined();
      expect(acts.setVolume).toBeUndefined();
      expect(acts.setRingtoneVolume).toBeUndefined();
    });

    it("an NVR (station codec, no speaker) gets NO audio actions", () => {
      const nvr = ctx(0, { codec: "station", deviceType: DeviceType.NVR_S4_MAX });
      const { acts } = bind<AudioActions>("audio", nvr);
      expect(Object.keys(acts)).toHaveLength(0);
      expect(buildCommand("alarmVolume", 50, nvr)).toBeUndefined();
      expect(buildCommand("promptVolume", 50, nvr)).toBeUndefined();
    });

    it("setAlarmVolume → station-scalar 1235 on the station channel 255", async () => {
      const { acts, sent } = bind<AudioActions>("audio", hubCtx);
      await acts.setAlarmVolume!(44);
      expect(sent).toEqual([{ kind: "p2p-station-scalar", cmd: 1235, value: 44, channel: 255 }]);
    });

    it("setPromptVolume → 1350 set-payload wrapper {value} on ch0", async () => {
      const { acts, sent } = bind<AudioActions>("audio", hubCtx);
      await acts.setPromptVolume!(70);
      expect(sent).toEqual([{ kind: "set-payload", cmd: 1292, payload: { value: 70 }, channel: 0 }]);
    });

    it("a camera does NOT get the station actions", () => {
      const { acts } = bind<AudioActions>("audio", ctx(2));
      expect(acts.setAlarmVolume).toBeUndefined();
      expect(acts.setPromptVolume).toBeUndefined();
    });

    it("hubAlarmTone → 1350 set-payload {type} on ch0, explicit mValue3:0 (wire verified live on T8030)", () => {
      expect(buildCommand("hubAlarmTone", 2, hubCtx)).toEqual({
        kind: "set-payload",
        cmd: AUDIO_CMD.HUB_ALARM_TONE, // 1281
        payload: { type: 2 },
        channel: 0,
        mValue3: 0,
      });
    });

    it("hubAlarmTone buildCommand is gated on HomeBase (undefined on a non-HomeBase station)", () => {
      const nvr = ctx(0, { codec: "station", deviceType: DeviceType.NVR_S4_MAX });
      expect(buildCommand("hubAlarmTone", 2, nvr)).toBeUndefined();
    });

    it("setAlarmTone dispatches the same intent (actions path)", async () => {
      const { acts, sent } = bind<AudioActions>("audio", hubCtx);
      await acts.setAlarmTone!(2);
      expect(sent).toEqual([{ kind: "set-payload", cmd: 1281, payload: { type: 2 }, channel: 0, mValue3: 0 }]);
    });

    it("a camera does NOT get setAlarmTone", () => {
      const { acts } = bind<AudioActions>("audio", ctx(2));
      expect(acts.setAlarmTone).toBeUndefined();
    });

    it("HubAlarmTone is 1-indexed (2 options, no index 0) — index↔name confirmed live on T8030", () => {
      expect(HubAlarmTone).toEqual({ Tone1: 1, Tone2: 2 });
    });

    it("HubAlarmTone.Tone1 plugs straight into setAlarmTone", async () => {
      const { acts, sent } = bind<AudioActions>("audio", hubCtx);
      await acts.setAlarmTone!(HubAlarmTone.Tone1);
      expect(sent).toEqual([{ kind: "set-payload", cmd: 1281, payload: { type: 1 }, channel: 0, mValue3: 0 }]);
    });

    it(
      "hubAlarmTone throws on anything outside {1,2} — not clamped, since a wrong tone is a wrong " +
        "value, not a safe default",
      () => {
        expect(() => buildCommand("hubAlarmTone", 0, hubCtx)).toThrow(
          /alarmTone: 0 is not a valid value \(must be one of 1\/2\)/,
        );
        expect(() => buildCommand("hubAlarmTone", 3, hubCtx)).toThrow(
          /alarmTone: 3 is not a valid value \(must be one of 1\/2\)/,
        );
        expect(() => buildCommand("hubAlarmTone", "x", hubCtx)).toThrow(
          /alarmTone: "x" is not a valid value \(must be one of 1\/2\)/,
        );
      },
    );

    /** The refusal is generated from the member's own `enumValues` rather than hand-written. */
    it("setAlarmTone rejects an invalid value with a descriptive error, same validation as buildCommand", async () => {
      const { acts, sent } = bind<AudioActions>("audio", hubCtx);
      await expect(acts.setAlarmTone!(5)).rejects.toThrow(/alarmTone: 5 is not a valid value \(must be one of 1\/2\)/);
      expect(sent).toEqual([]);
    });
  });

  describe("ringtone volume — doorbell-only, folded into the audio capability", () => {
    const doorbellCtx = ctx(2, { capabilities: new Set(["camera", "audio", "doorbell"]) });
    const cameraCtx = ctx(0, { capabilities: new Set(["camera", "audio"]) });

    it("setRingtoneVolume is present ONLY on a doorbell, and writes 1708 direct-binary", async () => {
      expect(bind<AudioActions>("audio", cameraCtx).acts.setRingtoneVolume).toBeUndefined();

      const { acts, sent } = bind<AudioActions>("audio", doorbellCtx);
      expect(acts.setRingtoneVolume).toBeDefined();
      await acts.setRingtoneVolume!(50);
      expect(sent).toEqual([{ kind: "set-param", param: 1708, value: 50, form: "direct-binary", channel: 2 }]);
    });

    it("buildCommand('ringtoneVolume') is gated on the doorbell capability", () => {
      expect(buildCommand("ringtoneVolume", 90, doorbellCtx)).toMatchObject({
        kind: "set-param",
        param: 1708,
        value: 90,
        form: "direct-binary",
      });
      expect(buildCommand("ringtoneVolume", 90, cameraCtx)).toBeUndefined();
    });
  });
});
