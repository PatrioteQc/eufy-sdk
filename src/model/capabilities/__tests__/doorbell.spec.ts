import { DOORBELL, DOORBELL_CMD, DoorbellRingtone, type DoorbellActions } from "../doorbell.js";
import { buildCommand } from "../index.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";

const ctx = (channel = 0, extra: Partial<CommandContext> = {}): CommandContext => ({
  channel,
  codec: "camera",
  // The barrel's `buildCommand` only lets a module answer for a capability the device HAS; these ctxs
  // hand evidence directly rather than through detection, so the resolved set is stated.
  capabilities: new Set(["doorbell"] as const),
  paramIds: new Set<number>(),
  ...extra,
});

describe("doorbell capability module", () => {
  it("declares the capability + schema", () => {
    expect(DOORBELL.capability).toBe("doorbell");
    expect(DOORBELL.properties.map((p) => p.name)).toEqual([
      "chimeSwitch",
      "mechanicalChimeSwitch",
      "wdrSwitch",
      "ringtoneVolume",
      "dingdongVolume",
      "dingdongRingtone",
      "notificationMode",
    ]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of DOORBELL.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("does not publish the camera-owned status LED under the doorbell capability", () => {
    expect(DOORBELL.properties.some((p) => p.name === "doorbellLedEnable")).toBe(false);
    const doorbellCtx = ctx(3, {
      capabilities: new Set(["camera", "doorbell"]),
      deviceType: 94,
      model: "T8214",
      paramIds: new Set([1716]),
    });
    expect(buildCommand("doorbellLedEnable", true, doorbellCtx)).toBeUndefined();
  });

  it("detects via the doorbell model-name regex", () => {
    const re = DOORBELL.detection!.modelHints![0];
    expect(re.test("Video Doorbell")).toBe(true);
    expect(re.test("Indoor Cam")).toBe(false);
  });

  describe("buildCommand — direct-binary chime/image toggles (wire captured live on T8214)", () => {
    it("mechanicalChimeSwitch on → set-param 'direct-binary' scalar for 1703", () => {
      expect(buildCommand("mechanicalChimeSwitch", true, ctx(2))).toEqual({
        kind: "set-param",
        param: DOORBELL_CMD.MECHANICAL_CHIME_SWITCH,
        value: 1,
        form: "direct-binary",
        channel: 2,
      });
    });

    it("mechanicalChimeSwitch off → value 0, same shape", () => {
      expect(buildCommand("mechanicalChimeSwitch", false, ctx(2))).toEqual({
        kind: "set-param",
        param: DOORBELL_CMD.MECHANICAL_CHIME_SWITCH,
        value: 0,
        form: "direct-binary",
        channel: 2,
      });
    });

    it("wdrSwitch on/off → same 136-byte direct-binary shape for 1704, on ctx.channel (not hardcoded)", () => {
      expect(buildCommand("wdrSwitch", true, ctx(3))).toEqual({
        kind: "set-param",
        param: DOORBELL_CMD.WDR_SWITCH,
        value: 1,
        form: "direct-binary",
        channel: 3,
      });
      expect(buildCommand("wdrSwitch", false, ctx(3))).toMatchObject({ value: 0 });
    });
  });

  describe("buildCommand — 1350 SET_PAYLOAD dingdong controls (wire captured live on T8214)", () => {
    it("dingdongVolume → set-payload cmd 1717, {dingdong_volume}, explicit mValue3:0", () => {
      expect(buildCommand("dingdongVolume", 25, ctx(2))).toEqual({
        kind: "set-payload",
        cmd: DOORBELL_CMD.DINGDONG_VOLUME,
        payload: { dingdong_volume: 25 },
        channel: 2,
        mValue3: 0,
      });
    });

    it("dingdongVolume on ctx.channel (not hardcoded)", () => {
      expect(buildCommand("dingdongVolume", 3, ctx(7))).toMatchObject({ channel: 7 });
    });

    it("dingdongVolume rejects anything outside 0..100, like every sibling volume setter", () => {
      expect(() => buildCommand("dingdongVolume", 250, ctx(2))).toThrow(
        /dingdongVolume: 250 is not a valid value \(must be in 0\.\.100\)/,
      );
      expect(() => buildCommand("dingdongVolume", -10, ctx(2))).toThrow(
        /dingdongVolume: -10 is not a valid value \(must be in 0\.\.100\)/,
      );
    });

    it("dingdongRingtone → set-payload cmd 1718, {dingdong_ringtone}, explicit mValue3:0 (an index, not a bool)", () => {
      expect(buildCommand("dingdongRingtone", 4, ctx(2))).toEqual({
        kind: "set-payload",
        cmd: DOORBELL_CMD.DINGDONG_RINGTONE,
        payload: { dingdong_ringtone: 4 },
        channel: 2,
        mValue3: 0,
      });
    });

    it("dingdongRingtone accepts 0 (a valid selection index, not a falsy no-op)", () => {
      expect(buildCommand("dingdongRingtone", 0, ctx(2))).toEqual({
        kind: "set-payload",
        cmd: DOORBELL_CMD.DINGDONG_RINGTONE,
        payload: { dingdong_ringtone: 0 },
        channel: 2,
        mValue3: 0,
      });
    });

    it(
      "dingdongRingtone THROWS on an out-of-range/non-numeric index — a selection, so a bad pick " +
        "must not land on a real-but-wrong tone",
      () => {
        for (const bad of [99, -5, "x", 4.5]) {
          expect(() => buildCommand("dingdongRingtone", bad, ctx(2))).toThrow(
            /dingdongRingtone: .+ is not a valid value \(must be one of 0\/1\/2\/3\/4\/5\/6\/7\/8\/9\)/,
          );
        }
      },
    );
  });

  describe("DoorbellRingtone — index↔name map (T8214, 2026-07-23)", () => {
    it("has 10 entries, 0-indexed (anchors 0/7/8 wire-tested, rest inferred from the picker read-off)", () => {
      expect(DoorbellRingtone).toEqual({
        Default: 0,
        Silent: 1,
        Beacon: 2,
        Chord: 3,
        Christmas: 4,
        Circuit: 5,
        Clock: 6,
        Ding: 7,
        Hillside: 8,
        Presto: 9,
      });
    });

    it("plugs straight into buildCommand's dingdongRingtone case", () => {
      expect(buildCommand("dingdongRingtone", DoorbellRingtone.Hillside, ctx(2))).toMatchObject({
        payload: { dingdong_ringtone: 8 },
      });
    });
  });

  describe("buildCommand — chime/image throw path", () => {
    /**
     * 1702's READ is confirmed on a T8214; the WRITE never was. Its 1703/1704 siblings share the param
     * range, which is not evidence of a shared frame — and a wrong guess on a fire-and-forget P2P write
     * looks exactly like success. So no setter exists on either entry point — the fluent object has no
     * `setChimeSwitch`, and the intent path says WHY rather than answering `undefined`, which would
     * report an uncaptured wire as a device that lacks the feature. The READ it does have is unaffected.
     */
    it("chimeSwitch is NOT settable — the intent path throws 'wire unverified' rather than guessing", () => {
      expect(() => buildCommand("chimeSwitch", true, ctx(2))).toThrow(/chimeSwitch write wire unverified/);
      const { acts } = bind<DoorbellActions>("doorbell", ctx(2));
      expect("setChimeSwitch" in acts).toBe(false);
      expect(DOORBELL.properties.some((p) => p.name === "chimeSwitch")).toBe(true);
    });

    it("an unhandled action returns undefined (falls through to another module)", () => {
      expect(buildCommand("nope", true, ctx())).toBeUndefined();
    });
  });
});
