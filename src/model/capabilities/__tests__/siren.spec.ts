import { SIREN, SIREN_PARAM, SIREN_CMD, SirenVolume, type SirenActions } from "../siren.js";
import { DeviceType } from "../../device-types.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";

/** The bound `dev.siren()` object — every write is a member, derived in the barrel. */
const sirenOf = (c: CommandContext) => bind<SirenActions>("siren", c);

const ctx = (paramIds = [61008, 1825, 61006, 1828], channel = 16): CommandContext =>
  ({ channel, codec: "sensor", serial: "T90R00000000000", paramIds: new Set(paramIds) }) as CommandContext;

describe("siren capability module", () => {
  it("declares the capability + schema", () => {
    expect(SIREN.capability).toBe("siren");
    expect(SIREN.properties.map((p) => p.name)).toEqual(["siren", "sirenVolume", "alarmDuration", "doNotDisturb"]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of SIREN.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
  });

  it("pins the exact ids a real siren reports — a fabricated id must fail here", () => {
    const ids = SIREN.properties.map((p) => p.paramType);
    expect(ids).toEqual([61008, 1825, 61006, 1828]);
    expect(ids).not.toContain(1300); // old guessed switch
    expect(ids).not.toContain(1230); // old guessed volume
    expect([
      SIREN_PARAM.RING_STATUS,
      SIREN_PARAM.ALARM_VOLUME,
      SIREN_PARAM.ALARM_TIMEOUT,
      SIREN_PARAM.NOT_DISTURB,
    ]).toEqual([61008, 1825, 61006, 1828]);
  });

  it("the sounding read is a confirmed boolean (a live test observed 1 then 0)", () => {
    const ring = SIREN.properties.find((p) => p.paramType === SIREN_PARAM.RING_STATUS);
    expect(ring?.type).toBe("bool");
    expect(ring?.writable).toBe(false);
  });

  it("volume + duration are now writable, verified", () => {
    for (const name of ["sirenVolume", "alarmDuration"]) {
      const p = SIREN.properties.find((x) => x.name === name);
      expect(p?.writable).toBe(true);
      expect(p?.provenance).toBe("verified");
    }
  });

  describe("writes (captured live on a T90R0)", () => {
    it("setVolume emits the 1350 SET_PAYLOAD the app sends ({volume}, mValue3 0, device channel)", async () => {
      const { acts: a, sent } = sirenOf(ctx());
      await a.setVolume!(SirenVolume.High);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        kind: "set-payload",
        cmd: SIREN_PARAM.ALARM_VOLUME,
        channel: 16,
        mValue3: 0,
        payload: { volume: 3 },
      });
    });

    it("setAlarmDuration emits {value} in seconds", async () => {
      const { acts: a, sent } = sirenOf(ctx());
      await a.setAlarmDuration!(300);
      expect(sent[0]).toMatchObject({ kind: "set-payload", cmd: SIREN_PARAM.ALARM_TIMEOUT, payload: { value: 300 } });
    });

    it("test + stop are momentary triggers (bare payload), gated on a reported siren param", async () => {
      // A device that reports a siren state param (here just ring-status) IS a siren, so test/stop install.
      const { acts: a, sent } = sirenOf(ctx([61008]));
      await a.test!();
      await a.stop!();
      expect(sent.map((c) => (c as { cmd: number }).cmd)).toEqual([SIREN_CMD.ALARM_TEST, SIREN_CMD.MANUAL_STOP]);
      expect(sent.every((c) => (c as { kind: string }).kind === "set-payload")).toBe(true);
    });

    it("installs nothing on a device that reports no siren param (curated/name-hint mis-detection)", () => {
      // The capability can land on a camera (curated list) or a renamed device (name hint); with none
      // of the siren params reported, even the momentary triggers stay off the wire.
      const a = sirenOf(ctx([])).acts as Record<string, unknown>;
      expect(a.setVolume).toBeUndefined();
      expect(a.setAlarmDuration).toBeUndefined();
      expect(a.test).toBeUndefined();
      expect(a.stop).toBeUndefined();
    });

    it("rejects out-of-range volume and non-preset duration rather than sending", async () => {
      const { acts: a, sent } = sirenOf(ctx());
      await expect(a.setVolume!(4)).rejects.toThrow(/1\/2\/3/);
      await expect(a.setVolume!(0)).rejects.toThrow(/1\/2\/3/);
      await expect(a.setAlarmDuration!(120)).rejects.toThrow(/60\/300\/600\/900/);
      await expect(a.setAlarmDuration!(0)).rejects.toThrow(/60\/300\/600\/900/);
      expect(sent).toEqual([]);
    });
  });

  describe("detection", () => {
    it("does NOT key on param 1015 (that's easSwitch, on ordinary cameras — not a siren signal)", () => {
      expect(SIREN.detection?.evidenceParams ?? []).not.toContain(1015);
    });
    it("proves siren via the standalone siren-sensor DeviceTypes", () => {
      expect(SIREN.detection?.deviceTypes).toContain(DeviceType.SIREN_SENSOR);
      expect(SIREN.detection?.deviceTypes).toContain(DeviceType.SIREN_SENSOR_E20);
    });
  });
});

/**
 * The derived surface, pinned at COMPILE time. Every siren write is gated on the device reporting a
 * siren param, so every one is optional — a caller cannot call one without checking, which is exactly
 * what "a present method means a verified wire" has to mean for a capability reachable by name hint.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const sn: SirenActions;

const _active: Exact<typeof sn.active, boolean | undefined> = true;
const _volume: Exact<typeof sn.volume, number | undefined> = true;
const _dnd: Exact<typeof sn.doNotDisturb, boolean | undefined> = true;

const _setVolumeOptional: Exact<undefined extends typeof sn.setVolume ? true : false, true> = true;
const _testOptional: Exact<undefined extends typeof sn.test ? true : false, true> = true;
const _testArgs: Exact<Parameters<NonNullable<typeof sn.test>>, []> = true;

// Read-only members get no setter: nothing can write the sounding state or do-not-disturb.
const _noSetActive: Exact<"setActive" extends keyof SirenActions ? true : false, false> = true;
const _noSetDnd: Exact<"setDoNotDisturb" extends keyof SirenActions ? true : false, false> = true;

export const _surfaceAssertions = [
  _active,
  _volume,
  _dnd,
  _setVolumeOptional,
  _testOptional,
  _testArgs,
  _noSetActive,
  _noSetDnd,
];
