import { DoorbellPushEvent, HB3PairedDevicePushEvent } from "../push-events.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * Every `person_detection` feature, declared once. Both ids are placeholders pending capture.
 *
 * Exported so a caller can name the table its `*Actions` type is derived from, but NOT published:
 * each entry states its wire id and the evidence it was confirmed on, which the reference site
 * does not carry.
 * @internal
 */
export const PERSON_DETECTION_MEMBERS = {
  /**
   * The AI-detection master switch. Read-only despite being a switch: 1014 is a `guessed` placeholder,
   * and shipping a setter over an unconfirmed id would be a fire-and-forget write that looks like it
   * worked. Published as `personDetection` in the flat property namespace, since `detectionEnabled` is
   * a name several capabilities would claim.
   */
  detectionEnabled: {
    param: 1014,
    property: "personDetection",
    type: "bool",
    kind: "boolean",
    provenance: "guessed",
    description: "Human/AI detection enabled. UNVERIFIED: placeholder id pending capture verification.",
  },
  /**
   * The live "someone is there" flag, which the device does not actually hold as state — it announces a
   * person as a push event, which is what this module's `events` rows carry. 1016 is a placeholder kept
   * so the flag has a home if a param turns out to mirror it; until then the events are the real read.
   */
  detected: {
    param: 1016,
    property: "personDetected",
    type: "bool",
    kind: "boolean",
    provenance: "guessed",
    description:
      "Live person-detected state. UNVERIFIED: actually delivered as a push event, not a state param; " +
      "placeholder id pending verification.",
  },
} as const satisfies Members;

/** Bound person-detection reads — the object returned by `dev.personDetection()`. Read-only. */
export type PersonDetectionActions = Surface<typeof PERSON_DETECTION_MEMBERS>;

/**
 * `person_detection` — human/AI detection. Mostly behaviour + push events; the enable
 * switch is modelled, the live detected flag is a placeholder.
 */
export const PERSON_DETECTION: CapabilityModule = {
  capability: "person_detection",
  description: "AI human detection enable switch and live detected state.",
  members: PERSON_DETECTION_MEMBERS,
  properties: propertiesOf(PERSON_DETECTION_MEMBERS),
  /**
   * Inbound AI person events. A face or an identified person is `personDetected`; an explicitly
   * UNRECOGNISED person is `strangerDetected`.
   *
   * The two are split because they mean opposite things to a host — "someone you know is at the door"
   * versus "someone you don\'t" — and collapsing them loses the distinction the device went to the
   * trouble of making. A host that wants either still listens for both.
   */
  events: [
    { source: "push", match: DoorbellPushEvent.FACE_DETECTION, emit: "personDetected" },
    { source: "push", match: HB3PairedDevicePushEvent.IDENTITY_PERSON_DETECTION, emit: "personDetected" },
    { source: "push", match: HB3PairedDevicePushEvent.STRANGER_PERSON_DETECTION, emit: "strangerDetected" },
  ],
};
