#!/usr/bin/env bash
# Publication guard for the generated API reference (hard rule, no exceptions).
#
# The docs site is PUBLIC. The TypeDoc-generated `api/` pages are built from JSDoc on the library's
# source, so a wire/crypto/reverse-engineering phrase in a public symbol's doc comment would leak
# straight onto the site — exactly what CONTRIBUTING.md forbids. `@internal`/private members are
# excluded from generation; this catches anything that slips through a PUBLIC member's comment.
#
# Fix a hit by rewording the offending JSDoc to host-facing language (move wire provenance into an
# inline `//` comment, which TypeDoc does not render) or by tagging the member `@internal`.
#
# Run AFTER `npm run docs:api`. Folded into `npm run build` (and mirrored in CI via .github/workflows/docs.yml).
set -uo pipefail

API_DIR="${1:-api}"

if [ ! -d "$API_DIR" ]; then
  echo "::error::$API_DIR/ not found — run 'npm run docs:api' before the docs guard"
  exit 1
fi

# Wire-protocol / crypto / reverse-engineering tokens, plus any markdown path — a generated API page
# has no business linking at a repo file, and the generic form cannot go stale the way an enumerated
# filename list would.
# `P2P`, `WebRTC`, `MQTT`, `FCM`, `CMAF`, `Annex-B`, `H.264` are host-facing terms and NOT banned.
PATTERN='PPCS|ECIES|signCode|algo_ecdh|ThroughTek|key-unwrap|handshake|reverse[ -]eng|mTLS|\bECDH\b|\bAES-|\bGCM\b|\bMCS\b|CMD_[A-Z0-9_]+|SET_PAYLOAD|SET_DEVICE_NAME|SET_HUB_NAME|register_push_token|level-[12]\b|[A-Za-z0-9_/-]+\.md\b'

# Bare wire param/command ids. A host drives a device by PROPERTY NAME (`battery`, `nightVision`), so a
# numeric id in a public doc is pure wire vocabulary. Ids live on in the source as named constants —
# this bans them from the PUBLISHED reference, not from the code.
ID_PATTERN='(^|[^0-9A-Za-z_./-])(1[0-9]{3}|2[13-9][0-9]{2}|3[0-9]{3}|6[0-9]{3})([^0-9A-Za-z_%]|$)'

# Numbers in the id range that legitimately appear in host-facing prose: video resolutions and round
# durations/sizes. None is a real param id in this SDK, so dropping them costs no coverage and keeps a
# sentence like "1080 lines" from failing the build.
ID_BENIGN='\b(1080|1440|1920|2160|2560|3840|1000|1024|2000|3000|6000)\b'

# Capture provenance. How a finding was obtained belongs in the source, not on the site.
PROVENANCE='verified live|live-verified|wire-verified|wire-confirmed|captured live|live capture|confirmed live|decompil|disassembl|\bAPK\b|rooted phone|instrumentation hook'

# Internal module paths. A published reference must not route the reader into src/.
INTERNAL_PATH='(transport|model|client|core)/[a-z0-9-]+(/[a-z0-9-]+)*\.ts'

fail=0
report() {
  local hits="$2"
  [ -z "$hits" ] && return 0
  echo "::error::publication guard: $1"
  echo "$hits"
  echo ""
  fail=1
}

report "wire/crypto/RE detail leaked into the generated API reference:" \
  "$(grep -rniE "$PATTERN" "$API_DIR" 2>/dev/null)"
report "a bare wire param/command id leaked into the generated API reference:" \
  "$(grep -rnE "$ID_PATTERN" "$API_DIR" 2>/dev/null | grep -vE "$ID_BENIGN")"
report "capture provenance leaked into the generated API reference:" \
  "$(grep -rniE "$PROVENANCE" "$API_DIR" 2>/dev/null)"
report "an internal source path leaked into the generated API reference:" \
  "$(grep -rnE "$INTERNAL_PATH" "$API_DIR" 2>/dev/null)"

if [ "$fail" -ne 0 ]; then
  echo "Reword the source JSDoc to host-facing language, or tag the member @internal. See CONTRIBUTING.md."
  exit 1
fi

echo "docs guard OK — no wire/crypto/RE leaks in $API_DIR/"
exit 0
