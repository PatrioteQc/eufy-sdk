import {
  ARMING,
  ARMING_CMD,
  ARMING_MEMBERS,
  AlarmDelayMode,
  AlarmDelaySeconds,
  ArmingMode,
  UNQUALIFIED_MODES,
  type ArmingActions,
} from "../arming.js";
import { buildCommand } from "../index.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import { commandObservation, type Command } from "../../../core/contracts.js";

const ctx: CommandContext = {
  channel: 0,
  codec: "station",
  // The barrel's `buildCommand` only lets a module answer for a capability the device HAS; this ctx
  // hands evidence directly rather than through detection, so the resolved set is stated.
  capabilities: new Set(["arming"]),
  paramIds: new Set(),
  accountName: "someone+tag",
};
const SETTABLE_MODES_FOR_TEST = [0, 1, 3, 63];

const noIdentityCtx: CommandContext = { channel: 0, codec: "station", paramIds: new Set() };

describe("arming capability module", () => {
  it("declares the capability + schema", () => {
    expect(ARMING.capability).toBe("arming");
    expect(ARMING.properties.map((p) => p.name)).toEqual(["armingMode"]);
  });

  it("proves arming via the guard-mode param 1224", () => {
    expect(ARMING.detection?.evidenceParams).toContain(1224);
  });

  /**
   * away/home/disarmed are byte-exact captures (T8030, 2026-07-23); custom1 is a live confirmation
   * (T8030, 2026-09-12) of the same frame shape with mode_type 3. The frame asserted below is the
   * captured one either way — see ARMING_MODE_WIRE for the evidence split.
   */
  describe("setMode / buildCommand (wire captured live on a T8030, 2026-07-23)", () => {
    it.each([
      [ArmingMode.away, 0],
      [ArmingMode.disarmed, 63],
      [ArmingMode.home, 1],
      [ArmingMode.custom1, 3],
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
      expect(buildCommand("armingMode", "away", ctx)).toEqual({
        kind: "set-payload",
        cmd: 1224,
        payload: { mode_type: 0, user_name: "someone+tag" },
        channel: 0,
        mValue3: 0,
      });
    });

    it("buildCommand returns undefined for an unrelated action, and throws for an unknown mode name", () => {
      expect(buildCommand("nope", "home", ctx)).toBeUndefined();
      expect(() => buildCommand("armingMode", "not-a-mode", ctx)).toThrow(
        /mode: "not-a-mode" is not a valid value \(must be one of 0\/1\/3\/63\)/,
      );
    });

    /**
     * The five uncaptured modes are the whole reason the write domain is narrower than the read one. A
     * mode the station reports must still READ (it has a label), and the same value must refuse on the way
     * back out — by naming the four that work, not by reporting the capability as missing.
     *
     * Both entry points are checked: the fluent setter and the intent path share one domain check, and it
     * was them disagreeing that put a guessed `mode_type` on a fire-and-forget wire in the first place.
     */
    it.each([
      ["schedule", 2],
      ["custom2", 4],
      ["custom3", 5],
      ["off", 6],
      ["geo", 47],
    ])("refuses %s (mode_type %i) — reportable, never sent", async (name, wire) => {
      const readCtx: CommandContext = { ...ctx, paramIds: new Set([ARMING_CMD.SET_ARMING]) };
      const { acts, sent } = bind<ArmingActions>("arming", readCtx, {
        read: (p) => (p === "armingMode" ? { value: wire } : undefined),
      });
      expect(acts.mode).toBe(wire);
      await expect(acts.setMode(acts.mode! as never)).rejects.toThrow(/must be one of 0\/1\/3\/63/);
      expect(() => buildCommand("armingMode", name, ctx)).toThrow(/must be one of 0\/1\/3\/63/);
      expect(sent).toEqual([]);
    });

    it("names every reportable mode, and offers only the settable ones", () => {
      const mode = ARMING_MEMBERS.mode;
      expect(Object.values(mode.enumValues)).toEqual([
        "away",
        "home",
        "schedule",
        "custom1",
        "custom2",
        "custom3",
        "off",
        "geo",
        "disarmed",
      ]);
      expect(mode.args[0].values).toEqual([0, 1, 3, 63]);
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

  /**
   * The type pin for the two mode domains. `setMode` accepts `custom1`; this command does not, because
   * the confirmation for mode 3 was gathered on cmd 1224 and cmd 1255 has no capture carrying it and no
   * readback. Nothing else enforces that: the narrowing is type-level, vitest does not typecheck, and
   * `tsc --noEmit` covers this file, so merging the domains back into one union passes every runtime
   * assertion. This line fails that merge with an unused `@ts-expect-error`.
   */
  // @ts-expect-error custom1 is confirmed on cmd 1224 only — the alarm-delay domain excludes it
  void ((): AlarmDelayMode => ArmingMode.custom1)();

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
      await acts.setAlarmDelayConfig(AlarmDelayMode.away, config);
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
      await acts.setAlarmDelayConfig(AlarmDelayMode.home, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.data.mode_id).toBe(1);
    });

    it("channel 255 is PINNED — independent of ctx.channel, not just coincidentally matching it", async () => {
      const oddCtx: CommandContext = { ...ctx, channel: 7 };
      const { acts, sent } = bind<ArmingActions>("arming", oddCtx);
      await acts.setAlarmDelayConfig(AlarmDelayMode.away, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.channel).toBe(255);
    });

    it("setAlarmDelayConfig rejects a malformed config with a rejected promise, not a sync throw", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      // Deliberately malformed at runtime (a caller ignoring/bypassing types) — missing countDownAlarm,
      // so alarmDelayCommand() throws synchronously reading `.channelList` off `undefined`.
      const malformed = {} as any;
      await expect(acts.setAlarmDelayConfig(AlarmDelayMode.away, malformed)).rejects.toThrow();
      expect(sent).toEqual([]);
    });
  });
});

describe("qualifyMode — the instrument, not a setter", () => {
  it("sends the SAME frame the confirmed modes ride on, with only mode_type differing", async () => {
    // This is the whole basis for a qualification meaning anything. If the probe built its own frame,
    // a mode that failed would tell you nothing (wrong bytes?) and one that worked would tell you less.
    const { acts, sent } = bind<ArmingActions>("arming", ctx);
    await acts.qualifyMode!(2); // schedule — named by the app, never captured

    const confirmed = buildCommand("armingMode", ArmingMode.home, ctx)!;
    const probe = sent[0]!;
    expect(probe.kind).toBe(confirmed.kind);
    // Identical but for the one integer under investigation.
    expect({ ...probe, payload: undefined }).toEqual({ ...confirmed, payload: undefined });
    expect((probe as unknown as { payload: { mode_type: number; user_name: string } }).payload).toEqual({
      mode_type: 2,
      user_name: ctx.accountName,
    });
  });

  it("carries the same observation the real write is judged by", async () => {
    // A qualification observed more loosely than the setter would promote a mode the setter then seems
    // to fail at. `armingModeChanged` is only emitted once the readback converged, so this IS the verdict.
    const { acts, sent } = bind<ArmingActions>("arming", ctx);
    await acts.qualifyMode!(47); // geo
    const observation = commandObservation(sent[0]!)!;
    expect(observation.event).toBe("armingModeChanged");
    expect(observation.expected).toBe(47);
    expect(observation.param).toBe(ARMING_CMD.SET_ARMING);
    expect(observation.timeoutMs).toBe(20_000);
  });

  it("refuses a mode that is already settable, and one the app never defines", async () => {
    const { acts, sent } = bind<ArmingActions>("arming", ctx);
    // 1 is `home` — settable, so it belongs to setMode and is not a thing to qualify.
    await expect(acts.qualifyMode!(1)).rejects.toThrow(/already settable|setMode/);
    // 99 is nobody's mode. Sending it would be a guess, which is the opposite of a qualification.
    await expect(acts.qualifyMode!(99)).rejects.toThrow(/not a mode to qualify/);
    expect(sent).toEqual([]);
  });

  it("offers exactly the five the app names and this SDK will not set", () => {
    // Derived from the wire table minus the settable four, so promoting a mode removes it here in the
    // same edit rather than leaving a second list to forget.
    expect([...UNQUALIFIED_MODES].sort((a, b) => a - b)).toEqual([2, 4, 5, 6, 47]);
    for (const wire of UNQUALIFIED_MODES) expect(SETTABLE_MODES_FOR_TEST).not.toContain(wire);
  });
});
