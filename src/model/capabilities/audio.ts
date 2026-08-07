import { asBool, coerceEnumValue, enumLabels } from "../../core/util.js";
import { isHomeBase, HOMEBASE_TYPES } from "../device-family.js";
import { setScalar, setPayload, setStationScalar, isCameraCodec, hasCapability } from "./access.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule, CommandContext } from "./types.js";
import type { Command } from "../../core/contracts.js";

/** The station broadcast channel the HomeBase's own controls ride (not a device channel). */
const STATION_CHANNEL = 255;

/**
 * The P2P **feature-command ids** this audio capability drives — the outer-cmd IS the param id on the
 * camera side (direct-binary struct), or the inner cmd of a `1350` SET_PAYLOAD on the station side.
 * Capability-owned wire vocabulary (transport forwards `cmd.param` opaquely; full id→name catalog in
 * the generated `transport/p2p/commands.ts`). All ✅ wire-verified live — see the module JSDoc below.
 */
export const AUDIO_CMD = {
  /**
   * Microphone on/off (app `AUDIO_MICROPHONE_SWITCH`). ✅ Wire verified live on T8214: direct-binary
   * 136-byte struct, signCode 8, 1=on/0=off (a switch, not a mute).
   */
  AUDIO_MICROPHONE: 1240,
  /** Speaker on/off (app `AUDIO_SPEAKER_SWITCH`). ✅ Wire verified live on T8214 — direct-binary, 1=on/0=off. */
  AUDIO_SPEAKER: 1241,
  /** Speaker volume 0..100 (app `DOORBELL_AUDIO_VOLUME`). ✅ Same direct-binary wire; write verified live on T8214 (set 60 → param 60). */
  SPEAKER_VOLUME: 1230,
  /**
   * Audio recording on/off (app `DOORBELL_AUDIO_RECORDING_SWITCH`) — whether the camera records audio
   * with video. Reported by every camera. ✅ Wire reversed from a live outbound capture + L2 decrypt on
   * T8425 (ch3): `1350` SET_PAYLOAD on the device channel (mChannel = device ch, mValue3 0), payload
   * `{channel:<deviceCh>, record_mute:0|1}`. The key is `record_mute` and it is **INVERTED** —
   * `record_mute:1` = muted (recording OFF), `record_mute:0` = recording ON.
   */
  AUDIO_RECORDING: 1288,
  /**
   * Doorbell ringtone/chime volume 0..100 (app `DOORBELL_RINGTONE_VOLUME`). ✅ Wire verified live on
   * T8214 — same direct-binary 136-byte struct, signCode 8. Doorbell-only: this capability adds it when
   * the device is a doorbell.
   */
  DOORBELL_RINGTONE_VOLUME: 1708,
  /**
   * HomeBase speaker / **alarm** volume 0..100 (app `CMD_SET_HUB_SPK_VOLUME`). ✅ Wire verified live on
   * HomeBase 3 T8030 (audible test tone): direct-binary struct, signCode 8, on the **station channel
   * 255** (not the device channel). Station-only.
   */
  HUB_SPK_VOLUME: 1235,
  /**
   * HomeBase voice **prompt** volume 0..100 (app `APP_CMD_SET_PROMPT_VOLUME`). ✅ Wire verified live on
   * T8030 (audible): the `1350` SET_PAYLOAD wrapper on ch0 with `payload:{value}`. Station-only.
   */
  HUB_PROMPT_VOLUME: 1292,
  /**
   * HomeBase **alarm tone** — which siren/alert sound the HomeBase plays, DISTINCT from alarm
   * *volume* (1235) — its own separate setting in the app UI ("Alarm Tones" next to "Alarm Volume").
   * ✅ WIRE CONFIRMED on T8030 (2026-07-23):
   * `1350` SET_PAYLOAD wrapper, `cmd:1281`, `mChannel:0`, explicit `mValue3:0` (NOT the setPayload
   * default), `payload:{type:<int enum>}` — confirming `command_schema.json`'s `hub_alarm_tone` entry
   * exactly. Observed `type:2` selecting one of the tones from the picker. NOT the 132-byte
   * station-scalar struct `alarmVolume`/1235 uses, despite both being HomeBase speaker settings (an
   * earlier guess assumed they'd share a wire; the capture says otherwise). `param-dictionary.ts`
   * previously tagged this id `writable:false`, model-scoped to `T8010` only — corrected alongside
   * this capture (writable, T8030 added) since the setting is confirmed live on the fleet's HomeBase 3.
   *
   * **2 options, 1-INDEXED** (not 0-indexed) — a static APK dig found `str_alarm_tones_1/2/3` +
   * matching `tone01/02/03.mp3` assets, suggesting 3, but the live T8030 app UI only offers 2
   * ("Alarm Tone1"/"Alarm Tone2") — the 3rd static resource is unused/dead in this app version.
   * Index↔name CONFIRMED live (2026-07-23): sent `type:1` from eufy-mega and read back "Alarm Tone1"
   * highlighted in the app; the original capture's `type:2` matches the app's own pre-existing
   * selection, which was "Alarm Tone2". See {@link HubAlarmTone}.
   */
  HUB_ALARM_TONE: 1281,
} as const;

/**
 * HomeBase alarm tone options, 1-indexed (there is no index-0 option). The index↔name mapping is
 * confirmed on-device.
 */
export const HubAlarmTone = {
  Tone1: 1,
  Tone2: 2,
} as const;
/** A HomeBase alarm tone option — the value side of {@link HubAlarmTone}. */
export type HubAlarmToneValue = (typeof HubAlarmTone)[keyof typeof HubAlarmTone];

/**
 * Bound audio controls — the object returned by `dev.audio()`.
 *
 * Everything is DERIVED from `AUDIO_MEMBERS`. Which methods a device has depends on its FAMILY, so
 * every write is optional and a caller checks: a **camera/doorbell** gets `setMicrophone`/`setSpeaker`/
 * `setVolume`/`setAudioRecording` (+ `setRingtoneVolume` on a doorbell); a **HomeBase/station** gets
 * `setAlarmVolume`/`setPromptVolume`/`setAlarmTone`. One capability, all audio/volume controls.
 */
export type AudioActions = Surface<typeof AUDIO_MEMBERS>;

/** Camera/doorbell audio write — the direct-binary 136-byte struct (signCode 8), wire-verified on T8214. */
function audioCommand(param: number, value: number, ctx: CommandContext): Command {
  return setScalar(param, value, ctx, "direct-binary");
}

/**
 * Every `audio` feature, declared once — family-gated so one capability covers the whole fleet.
 *
 * The gate is `available` rather than `requires` because it is a FAMILY fact, not a reported param: a
 * HomeBase and a camera each report the other's volume ids in places (the hub reports 1230 too), so
 * keying on the param would hand a camera the station's alarm-volume wire. `isCameraCodec` / `isHomeBase`
 * are the same predicates the old routing table used.
 *
 * ✅ WIRE CONFIRMED. Camera side (Doorbell T8214): outer-cmd = the param id
 * (1240/1241/1230/1708), signCode 8, device channel, 168B→136B direct-binary struct
 * `[u32 channel][u32 value][account_id pad→128]`; polarity SWITCH (1⇒on, not a mute). Station side
 * (HomeBase T8030, both audibly confirmed): **alarm volume 1235 is a 132-byte struct
 * `[u32 value][account_id pad→128]` (NO channel field) on the station channel 255**; **prompt volume
 * 1292 rides the 1350 SET_PAYLOAD wrapper on ch0** with `payload:{value}`. NOTE cloud `get_devs_list`
 * does NOT reflect either (like spotlight-enable) — verify by ear.
 *
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const AUDIO_MEMBERS = {
  /**
   * A SWITCH, not a mute: `true` powers the mic, so the polarity reads the same way round on the wire
   * (1 = on) with no `invert`. Camera-family only — a HomeBase has no microphone, so the getter and
   * setter are both absent there and a caller must check.
   */
  microphone: {
    param: AUDIO_CMD.AUDIO_MICROPHONE,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    available: isCameraCodec,
    description: "Microphone on/off (1240 AUDIO_MICROPHONE_SWITCH; 1=on/0=off). Wire verified live on T8214.",
    write: (v, ctx) => audioCommand(AUDIO_CMD.AUDIO_MICROPHONE, asBool(v) ? 1 : 0, ctx),
  },
  /**
   * The camera's own speaker switch — what talkback and the doorbell's responses play out of. Distinct
   * from `volume`, which sets how loud it is: turning this off silences the camera whatever the level
   * says. Camera-family only, like `microphone` above; the station's speaker is `alarmVolume` /
   * `promptVolume` instead.
   */
  speaker: {
    param: AUDIO_CMD.AUDIO_SPEAKER,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    available: isCameraCodec,
    description: "Speaker on/off (1241 AUDIO_SPEAKER_SWITCH; 1=on/0=off). Wire verified live on T8214.",
    write: (v, ctx) => audioCommand(AUDIO_CMD.AUDIO_SPEAKER, asBool(v) ? 1 : 0, ctx),
  },
  /**
   * `volume` is the accessor a caller sees; the flat property has to be `speakerVolume` because three
   * capabilities claim `volume`. Both names reach the same write through the intent path.
   */
  volume: {
    param: AUDIO_CMD.SPEAKER_VOLUME,
    property: "speakerVolume",
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "verified",
    available: isCameraCodec,
    min: 0,
    max: 100,
    intentNames: ["volume"],
    description:
      "Speaker volume 0..100 (1230 DOORBELL_AUDIO_VOLUME). Write verified live on T8214 (set 60 → param 60).",
    write: (v, ctx) => audioCommand(AUDIO_CMD.SPEAKER_VOLUME, Number(v), ctx),
  },
  /** Raw param 1288 is `record_mute` (1 = muted / recording OFF), so audioRecording = NOT record_mute. */
  audioRecording: {
    param: AUDIO_CMD.AUDIO_RECORDING,
    type: "bool",
    kind: "boolean",
    invert: true,
    provenance: "verified",
    available: isCameraCodec,
    description:
      "Record audio with video (1288 record_mute, inverted). ✅ HW-verified on T8425: readback flips " +
      "(on→1288=0, off→1288=1). The write is a 1350 SET_PAYLOAD on the device channel with " +
      "`{channel, record_mute}` — the key is record_mute and it is INVERTED.",
    write: (v, ctx) =>
      setPayload(AUDIO_CMD.AUDIO_RECORDING, { channel: ctx.channel, record_mute: asBool(v) ? 0 : 1 }, ctx, 0),
  },
  /**
   * Doorbell ring/chime loudness — WRITE-ONLY here on purpose. The READ property `ringtoneVolume` (1708)
   * lives on the `doorbell` capability: 1708 leaks onto non-doorbell cameras, so it cannot be an `audio`
   * property (which spans all cameras) without over-surfacing junk. Audio owns the write.
   */
  ringtoneVolume: {
    param: AUDIO_CMD.DOORBELL_RINGTONE_VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    writeOnly: true,
    provenance: "verified",
    available: (ctx: AvailabilityContext) => hasCapability(ctx, "doorbell"),
    min: 0,
    max: 100,
    description: "Doorbell ring/chime volume 0..100 (1708 DOORBELL_RINGTONE_VOLUME). Wire verified live on T8214.",
    write: (v, ctx) => audioCommand(AUDIO_CMD.DOORBELL_RINGTONE_VOLUME, Number(v), ctx),
  },
  /**
   * HomeBase speaker/alarm volume — a 132-byte station-scalar on the STATION channel 255, not the device
   * channel, and write-only: the cloud record does not reflect it.
   */
  alarmVolume: {
    param: AUDIO_CMD.HUB_SPK_VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    writeOnly: true,
    provenance: "verified",
    available: isHomeBase,
    min: 0,
    max: 100,
    description: "HomeBase alarm/speaker volume 0..100 (1235 CMD_SET_HUB_SPK_VOLUME). Verified audible on a T8030.",
    write: (v) => setStationScalar(AUDIO_CMD.HUB_SPK_VOLUME, Number(v), STATION_CHANNEL),
  },
  /** HomeBase voice-prompt volume — the 1350 SET_PAYLOAD wrapper on ch0. Write-only, same as above. */
  promptVolume: {
    param: AUDIO_CMD.HUB_PROMPT_VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    writeOnly: true,
    provenance: "verified",
    available: isHomeBase,
    min: 0,
    max: 100,
    description: "HomeBase voice-prompt volume 0..100 (1292 APP_CMD_SET_PROMPT_VOLUME). Verified audible on a T8030.",
    write: (v, ctx) => setPayload(AUDIO_CMD.HUB_PROMPT_VOLUME, { value: Number(v) }, ctx),
  },
  /**
   * Which siren/alert sound the HomeBase plays — a fixed 2-option enum, DISTINCT from alarm volume.
   * `coerceEnumValue` rejects anything outside {@link HubAlarmTone} instead of coercing it: a
   * wrong-but-plausible tone index would otherwise dispatch as a real value on this fire-and-forget
   * write and look like it worked.
   */
  alarmTone: {
    param: AUDIO_CMD.HUB_ALARM_TONE,
    property: "hubAlarmTone",
    type: "number",
    kind: "enum",
    enumValues: enumLabels(HubAlarmTone),
    provenance: "verified",
    available: isHomeBase,
    args: [{ name: "tone", kind: "enum", description: "One of the app's alarm tones (1-indexed)." }],
    description:
      "HomeBase alarm tone/siren-sound selection, distinct from alarmVolume/1235 (1281 " +
      "APP_CMD_HUB_ALARM_TONE; 1350 SET_PAYLOAD, cmd 1281, mChannel 0, mValue3 0, payload:{type}). " +
      "✅ Wire verified live on T8030 (2026-07-23).",
    write: (v, ctx) => {
      const tone = coerceEnumValue(HubAlarmTone, v);
      return tone === undefined ? undefined : setPayload(AUDIO_CMD.HUB_ALARM_TONE, { type: tone }, ctx, 0);
    },
  },
} as const satisfies Members;

export const AUDIO: CapabilityModule = {
  capability: "audio",
  description:
    "Audio/volume controls, family-gated: camera/doorbell mic (1240) / speaker (1241) / volume (1230) " +
    "+ doorbell ringtone volume (1708); HomeBase alarm (1235) + voice-prompt (1292) volume.",
  members: AUDIO_MEMBERS,
  properties: propertiesOf(AUDIO_MEMBERS),
  // Cameras/doorbells: proven by the mic/speaker switch params (NOT 1230 alone — the hub reports 1230
  // too). The HomeBase family gets `audio` too (it has a speaker: alarm + voice prompts) — but gated on
  // the HOMEBASE deviceTypes, NOT the whole `station` codec: NVRs (S4 Max / PoE NVR) are also `station`
  // yet have no speaker, so codec-detection would wrongly expose setAlarmVolume/setPromptVolume on them.
  detection: {
    evidenceParams: [AUDIO_CMD.AUDIO_MICROPHONE, AUDIO_CMD.AUDIO_SPEAKER],
    deviceTypes: [...HOMEBASE_TYPES],
  },
};
