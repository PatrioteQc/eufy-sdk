import { pickDpParams } from "./access.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule } from "./types.js";
import { isAiotVacuum } from "../device-family.js";

/** DP id for the Omni dock control (StationResponse/StationRequest, DP 173). */
const VACUUM_DOCK_DP = 173 as const;

/**
 * Every `vacuum_dock` feature, declared once.
 *
 * DP 173 is confirmed in the T2351 `get_product_data_point` catalog (raw, rw). The read side
 * (`dockState`) lands the raw protobuf payload: field #1 = repeated {id,state} dock component
 * groups; field #5.1 = fill level %. Component id → name mapping is not yet confirmed on a live
 * device, so no typed getter is installed (`unexposed`). The write side (StationRequest) is not yet
 * reversed — write members carry `unverified` with no `write` field, so no setter is installed and
 * the intent path throws rather than guessing a frame.
 * @internal
 */
export const VACUUM_DOCK_MEMBERS = {
  /**
   * Raw Omni dock state (DP 173, StationResponse protobuf). In the property schema so
   * `decodeState` can land the value, but given no typed getter (`unexposed`) because the component
   * id → name mapping is not yet confirmed on a real device.
   *
   * Confirmed on T2351 (`get_product_data_point` catalog, 2026-08-05): DP 173 `station`, raw, rw.
   * StationResponse: field #1 = repeated {id,state} dock component groups; field #5.1 = fill level %.
   */
  dockState: {
    param: VACUUM_DOCK_DP,
    type: "string",
    provenance: "mega",
    unexposed: true,
    description:
      "Omni dock state (DP 173 StationResponse). Field #1 = repeated {id,state} dock component " +
      "groups; field #5.1 = fill level %. Component id→name mapping not yet confirmed on-device.",
  },
  /**
   * Trigger auto-empty of the dust collection bin. Write side of DP 173 (StationRequest). The
   * StationRequest protobuf is not yet reversed — `unverified` with no `write` field: no setter is
   * installed, and the intent path throws rather than guessing a frame.
   */
  emptyDust: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Trigger auto-empty dust collection (DP 173 StationRequest). Write wire not yet reversed — " +
      "unverified until confirmed on a device.",
  },
  /**
   * Trigger mop washing in the dock. Write side of DP 173 (StationRequest). Same unverified
   * standing as {@link emptyDust} — no setter is installed until the frame shape is captured.
   */
  washMops: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Trigger mop washing in the dock (DP 173 StationRequest). Write wire not yet reversed — " +
      "unverified until confirmed on a device.",
  },
  /**
   * Trigger mop drying in the dock. Write side of DP 173 (StationRequest). Same unverified
   * standing as {@link emptyDust} — no setter is installed until the frame shape is captured.
   */
  dryMops: {
    type: "bool",
    kind: "boolean",
    writeOnly: true,
    unverified: true,
    available: (ctx: AvailabilityContext) => isAiotVacuum(ctx),
    provenance: "mega",
    description:
      "Trigger mop drying in the dock (DP 173 StationRequest). Write wire not yet reversed — " +
      "unverified until confirmed on a device.",
  },
} as const satisfies Members;

/**
 * Bound Omni dock controls — the object returned by `dev.vacuumDock()`.
 *
 * All write members (`emptyDust`, `washMops`, `dryMops`) are `unverified` with no `write` field:
 * the StationRequest protobuf is not yet reversed, so no setter appears on the surface until the
 * wire is captured and confirmed. The `dockState` read is `unexposed`, so it is not typed here
 * either. The surface will fill out as wires are confirmed.
 */
export type VacuumDockActions = Surface<typeof VACUUM_DOCK_MEMBERS>;

/** `vacuum_dock` — Omni dock controls (auto-empty, mop wash, mop dry) for the RoboVac X10 Pro Omni (T2351). */
export const VACUUM_DOCK: CapabilityModule = {
  capability: "vacuum_dock",
  line: "clean",
  description: "RoboVac Omni dock controls: auto-empty, mop wash, mop dry (DP 173).",
  members: VACUUM_DOCK_MEMBERS,
  properties: propertiesOf(VACUUM_DOCK_MEMBERS),
  // Detected only when the device reports DP 173 — not a codec baseline; a dock station is
  // equipment the T2351 has and a plain RoboVac does not.
  detection: { evidenceParams: [VACUUM_DOCK_DP] },
  decodeState(signal) {
    const params = pickDpParams(signal.source === "mqtt" ? signal.dpParams : undefined, [VACUUM_DOCK_DP]);
    return params ? { params } : null;
  },
};
