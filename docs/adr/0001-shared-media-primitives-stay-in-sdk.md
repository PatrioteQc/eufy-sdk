# Keep Shared Media Primitives in the SDK

Status: accepted

The SDK owns verified device media truth and reusable media mechanics: typed inbound audio metadata, audio-aware container muxing, rolling prebuffer drainage, recording-budget extension, and correct readable-stream behavior. Host-specific representation remains outside the SDK: output codec negotiation, transcoding targets, bitrate and profile policy, packetization, and session keep-alives are the host's responsibility. This boundary lets every host consume the same truthful media primitives without coupling the SDK to one presentation protocol or service.

The media pass therefore completes existing SDK plumbing rather than introducing a host-specific recording feature. Fragmented recordings are caller-owned, evented async iterables so a caller can extend a shared battery budget without mixing control notices into media output. A fragment duration is a keyframe-bounded minimum, prebuffer is available only from an already-warm retained source, and APIs must not claim negotiation or timing guarantees that the device source cannot provide.
