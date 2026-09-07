import { DoorbellPushEvent, HB3PairedDevicePushEvent } from "../push-events.js";
import type { CapabilityModule } from "./types.js";

/**
 * `person_detection` — human/AI detection.
 *
 * Push events are the whole read surface: a person arrives as an event, and no owned camera reports a
 * detection-enable or detected-state parameter, so there is nothing for a state table to project.
 */
export const PERSON_DETECTION: CapabilityModule = {
  capability: "person_detection",
  description: "AI human detection enable switch and live detected state.",
  properties: [],
  /** Camera push traffic emits these semantic events even when no person-detection state param is reported. */
  detection: { codecs: ["camera"] },
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
