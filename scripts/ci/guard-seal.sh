#!/usr/bin/env bash
# WebRTC engine seal (hard rule, no exceptions).
#
# The WebRTC engine (werift) must NOT leak its type surface into the public declarations. The only
# door is core's engine-free WebRTCPeerHandle + the lazy `createWebRtcPeer` factory, so HomeBase/
# PPCS-only hosts never pull werift into their types (or eager-load it). A werift-typed .d.ts means
# someone re-exported the concrete WebRTCPeer or annotated a public member with an engine type.
# Doc-comment lines (`*`) are exempt; we match real references only. Run AFTER `npm run build`.
#
# Single source of truth: package.json `guard:seal` (folded into `npm run verify`) runs this; CI runs
# verify.
set -uo pipefail

if [ ! -d dist ]; then
  echo "::error::dist/ not found — run 'npm run build' before the seal guard"
  exit 1
fi

fail=0

if grep -rn 'import("werift")' dist --include='*.d.ts'; then
  echo "::error::werift import leaked into a public .d.ts (seal the WebRTC engine behind createWebRtcPeer/WebRTCPeerHandle — see Ask G)"
  fail=1
fi

if grep -rhE ':[[:space:]]*(RtpPacket|MediaStreamTrack|RTCPeerConnection|RTCRtpCodecParameters)\b' dist --include='*.d.ts' | grep -vE '^[[:space:]]*\*'; then
  echo "::error::a werift engine type leaked into a public .d.ts (seal the WebRTC engine behind createWebRtcPeer/WebRTCPeerHandle — see Ask G)"
  fail=1
fi

exit "$fail"
