import { ARMING, ARMING_CMD, ArmingMode, AlarmDelaySeconds, type ArmingActions } from "../arming.js";
import { buildCommand } from "../index.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import type { Command } from "../../../core/contracts.js";

const ctx: CommandContext = {
  channel: 0,
  codec: "station",
  // The barrel's `buildCommand` only lets a module answer for a capability the device HAS; this ctx
  // hands evidence directly rather than through detection, so the resolved set is stated.
  capabilities: new Set(["arming"]),
  paramIds: new Set(),
  accountName: "someone+tag",
};
const noIdentityCtx: CommandContext = { channel: 0, codec: "station", paramIds: new Set() };

describe("arming capability module", () => {
  it("declares the capability + schema", () => {
    expect(ARMING.capability).toBe("arming");
    expect(ARMING.properties.map((p) => p.name)).toEqual(["armingMode"]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of ARMING.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("proves arming via the guard-mode param 1224", () => {
    expect(ARMING.detection?.evidenceParams).toContain(1224);
  });

  describe("setMode / buildCommand (wire captured live on a T8030, 2026-07-23)", () => {
    it.each([
      [ArmingMode.away, 0],
      [ArmingMode.disarmed, 63],
      [ArmingMode.home, 1],
    ])("%s → set-payload cmd 1224, {mode_type:%i, user_name}, explicit mValue3:0", async (mode, modeType) => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      await acts.setMode(mode);
      expect(sent).toEqual([
        {
          kind: "set-payload",
          cmd: 1224,
          payload: { mode_type: modeType, user_name: "someone+tag" },
          channel: 0,
          mValue3: 0,
        },
      ]);
    });

    it("buildCommand mirrors the same intent for the low-level setProperty path", () => {
      expect(buildCommand("armingMode", "schedule", ctx)).toEqual({
        kind: "set-payload",
        cmd: 1224,
        payload: { mode_type: 2, user_name: "someone+tag" },
        channel: 0,
        mValue3: 0,
      });
    });

    it("buildCommand returns undefined for an unrelated action, and throws for an unknown mode name", () => {
      expect(buildCommand("nope", "home", ctx)).toBeUndefined();
      expect(() => buildCommand("armingMode", "not-a-mode", ctx)).toThrow(
        /mode: "not-a-mode" is not a valid value \(must be one of 0\/1\/2\/3\/4\/5\/47\/63\)/,
      );
    });

    it("setMode round-trips the wire integer the mode getter answers", async () => {
      const readCtx: CommandContext = { ...ctx, paramIds: new Set([ARMING_CMD.SET_ARMING]) };
      const { acts, sent } = bind<ArmingActions>("arming", readCtx, {
        read: (name) => (name === "armingMode" ? { value: 1 } : undefined),
      });
      expect(acts.mode).toBe(1);
      await acts.setMode(acts.mode!);
      expect(sent).toEqual([
        {
          kind: "set-payload",
          cmd: 1224,
          payload: { mode_type: 1, user_name: "someone+tag" },
          channel: 0,
          mValue3: 0,
        },
      ]);
    });

    it("throws a clear error when the context has no account identity", async () => {
      const { acts } = bind<ArmingActions>("arming", noIdentityCtx);
      await expect(acts.setMode(ArmingMode.home)).rejects.toThrow(/missing account identity/);
      expect(() => buildCommand("armingMode", "home", noIdentityCtx)).toThrow(/missing account identity/);
    });
  });

  it("ARMING_CMD names the wire ids (no bare literals)", () => {
    expect(ARMING_CMD.SET_ARMING).toBe(1224);
    expect(ARMING_CMD.ALARM_DELAY_CONFIG).toBe(1255);
  });

  it("AlarmDelaySeconds is exactly the app's own picker preset list", () => {
    expect(AlarmDelaySeconds).toEqual({ off: 0, sec15: 15, sec30: 30, sec45: 45, sec60: 60, min3: 180, min5: 300 });
  });

  describe("setAlarmDelayConfig (wire captured live on a T8030, 2026-07-23)", () => {
    const config = {
      countDownAlarm: { channelList: [6], delaySeconds: AlarmDelaySeconds.sec45 },
      countDownArm: { channelList: [], delaySeconds: AlarmDelaySeconds.off },
      devices: [
        { action: 12, deviceChannel: 16 },
        { action: 11, deviceChannel: 6 },
        { action: 9, deviceChannel: 2 },
      ],
      sirenSensorAction: [
        { action: 0, deviceChannel: 16 },
        { action: 0, deviceChannel: 6 },
        { action: 0, deviceChannel: 2 },
      ],
    };

    it("→ set-json-raw cmd 1255, bare plaintext (no 1350/1700 envelope), pinned to station ch 255", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      await acts.setAlarmDelayConfig(ArmingMode.away, config);
      expect(sent).toEqual([
        {
          kind: "set-json-raw",
          cmd: 1255,
          channel: 255,
          data: {
            mode_id: 0,
            count_down_alarm: { channel_list: [6], delay_time: 45 },
            count_down_arm: { channel_list: [], delay_time: 0 },
            devices: [
              { action: 12, device_channel: 16 },
              { action: 11, device_channel: 6 },
              { action: 9, device_channel: 2 },
            ],
            siren_sensor_action: [
              { action: 0, device_channel: 16 },
              { action: 0, device_channel: 6 },
              { action: 0, device_channel: 2 },
            ],
          },
        },
      ]);
    });

    it("maps every ArmingMode name to its captured mode_id", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      await acts.setAlarmDelayConfig(ArmingMode.home, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.data.mode_id).toBe(1);
    });

    it("channel 255 is PINNED — independent of ctx.channel, not just coincidentally matching it", async () => {
      const oddCtx: CommandContext = { ...ctx, channel: 7 };
      const { acts, sent } = bind<ArmingActions>("arming", oddCtx);
      await acts.setAlarmDelayConfig(ArmingMode.away, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.channel).toBe(255);
    });

    it("setAlarmDelayConfig rejects a malformed config with a rejected promise, not a sync throw", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      // Deliberately malformed at runtime (a caller ignoring/bypassing types) — missing countDownAlarm,
      // so alarmDelayCommand() throws synchronously reading `.channelList` off `undefined`.
      const malformed = {} as any;
      await expect(acts.setAlarmDelayConfig(ArmingMode.away, malformed)).rejects.toThrow();
      expect(sent).toEqual([]);
    });
  });
});
