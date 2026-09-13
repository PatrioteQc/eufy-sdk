import type { CapabilityModule } from "./types.js";
import { propertiesOf, type Members, type Surface } from "./members.js";

/**
 * `display` — what a eufy Smart Display (T87Ax) actually reports.
 *
 * A deliberately small capability, and the smallness IS the finding. The Smart Display shares a cloud
 * account with the security line and nothing else: the one captured unit (a T87A0, 2026-09-04) connects
 * over secure MQTT with no `p2p_did`, so it speaks no P2P at all, and it reported exactly six params in
 * an id range (8001-8006) that no other line uses. Three of those six can be named from the capture and
 * are here; three cannot and are not — see {@link DISPLAY_PARAMS} for what each unnamed one looked like
 * and what would settle it.
 *
 * **Nothing here is writable, and that is not a gap in this module.** No capture pins a write for any
 * display param, and an AIoT write is fire-and-forget — a wrong frame to a device that acknowledges
 * nothing looks exactly like success. So there is no setter to offer and none is guessed. A screen, a
 * volume, an assistant: the device plainly has all three and reports none of them in anything captured
 * so far, which means the reads have to arrive before any control can be honest about what it moves.
 *
 * Why it exists at all rather than leaving the codec bare: until this module the only capability a
 * Smart Display resolved was `info`, whose values come from the cloud record rather than from the
 * device, so `describe()` reported a device that had told us nothing. It had in fact told us its model,
 * its retail name and something version-shaped. Reporting three real reads is a better answer than
 * none, and it gives a consumer a reason to render the device at all.
 *
 * @module model/capabilities/display
 */

/**
 * Smart Display param ids — this line's own vocabulary (`display` namespace, ids 8001-8006).
 *
 * Only the mapped three are named. The others are real and reported; they are absent here for the same
 * reason they are absent from the dictionary, which is that a name would be a guess.
 */
export const DISPLAY_PARAM = {
  /** Something version-shaped (`"2.9.05"` on the capture). Provenance `guessed` — see the dictionary. */
  SOFTWARE_VERSION: 8003,
  /** The model's retail name, verbatim (`"Smart Display E10"`). */
  MODEL_NAME: 8005,
  /** The device's own model code (`"T87A0"`). */
  MODEL_CODE: 8006,
} as const;

/**
 * Every `display` read. All read-only; see the module note for why there is no write.
 *
 * Exported but NOT published: each entry states its wire id and what the claim rests on, which the
 * reference site does not carry.
 * @internal
 */
export const DISPLAY_MEMBERS = {
  /**
   * The model's retail name as the DEVICE reports it.
   *
   * Worth having beside `info.name` rather than folded into it, because the two answer different
   * questions: `info` is sourced from the cloud record and the curated registry, this is the device's
   * own answer. Where they agree — they did on the capture — that agreement is the evidence the id means
   * what it is named. Where a future unit disagrees, the disagreement is the interesting part and would
   * be lost if this were quietly merged into identity metadata.
   */
  modelName: {
    param: DISPLAY_PARAM.MODEL_NAME,
    type: "string",
    kind: "text",
    provenance: "mega",
    description: "The model's retail name as the display reports it (param 8005).",
  },
  /** The device's own model code, which matched its cloud `model` exactly on the capture. */
  modelCode: {
    param: DISPLAY_PARAM.MODEL_CODE,
    type: "string",
    kind: "text",
    provenance: "mega",
    description: "The display's own model code (param 8006).",
  },
  /**
   * Something version-shaped, named for what it looks like.
   *
   * The weakest claim in this module and labelled as such: `provenance: "guessed"`. One dotted value on
   * one device is a reason to expect a version and not a mapping anyone confirmed, so a consumer showing
   * this as a firmware version is showing an inference. `info.firmwareVersion` remains the field to
   * trust when the cloud record carries one — this display's record did not.
   */
  softwareVersion: {
    param: DISPLAY_PARAM.SOFTWARE_VERSION,
    type: "string",
    kind: "text",
    provenance: "guessed",
    description:
      "A version-shaped string the display reports (param 8003). Named for its shape, not from a " +
      "confirmed mapping — prefer info.firmwareVersion where the cloud record carries one.",
  },
} as const satisfies Members;

/** `display` — the reads a eufy Smart Display (T87Ax) publishes. Read-only; no write is captured. */
export const DISPLAY: CapabilityModule = {
  capability: "display",
  line: "display",
  description: "Smart Display reads: its own model code, retail name and a version-shaped string.",
  members: DISPLAY_MEMBERS,
  properties: propertiesOf(DISPLAY_MEMBERS),
  /**
   * Claimed by CODEC, not by an evidence param.
   *
   * The three ids are reported in the device's cloud record, so the ordinary evidence gate would install
   * each getter anyway — but the capability should attach to a Smart Display that reports none of them
   * too, because a device on this line has no other capability to carry it. The line partition is what
   * keeps this off everything else: `display` is the only codec in the `display` line.
   */
  detection: { codecs: ["display"] },
};

/** Bound Smart Display reads — the object returned by `dev.display()`. All read-only. */
export type DisplayActions = Surface<typeof DISPLAY_MEMBERS>;
