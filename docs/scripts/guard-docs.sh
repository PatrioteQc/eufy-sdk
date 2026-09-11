#!/usr/bin/env bash
# Publication guard for the generated API reference.
#
# The reference covers the whole public surface, `transport/` included, since `src/index.ts` exports
# it. Wire and crypto vocabulary belongs in these pages: it documents the wire.
#
# Two things do not, and this catches them:
#
#   method — the TOOLING a finding came from: a decompiler, a packaged app, a rooted handset, a packet
#            capture. That is how the work was done, not what the API is.
#   source paths — a published reference must describe symbols, not route a reader into `src/`.
#
# Confirmation STATUS is not method and is not banned. "Wire-confirmed", "verified live", "unverified"
# tell a caller whether a path is grounded or guessed, which is exactly what they need to know before
# depending on it.
#
# Fix a hit by rewording the JSDoc, or by tagging the member `@internal` so it is not generated.
#
# Run AFTER `npm run docs:api`. Folded into `npm run build`, and into CI via .github/workflows/docs.yml.
set -uo pipefail

API_DIR="${1:-api}"

if [ ! -d "$API_DIR" ]; then
  echo "::error::$API_DIR/ not found — run 'npm run docs:api' before the docs guard"
  exit 1
fi

METHOD='decompil|disassembl|\bAPK\b|rooted phone|rooted handset|instrumentation hook|\bfrida\b|tcpdump|\bpcap\b|packet capture|mitm'

INTERNAL_PATH='(transport|model|client|core)/[a-z0-9-]+(/[a-z0-9-]+)*\.ts'

# No check for markdown links here: TypeDoc fills these pages with its own relative navigation
# (`../../../index.md` breadcrumbs, `classes/Foo.md`), and a pattern loose enough to catch a link
# escaping into repo prose catches hundreds of those too. `guard:docrefs` stops prose references at
# the source instead, which is where this reference is generated from.

fail=0
report() {
  local hits="$2"
  [ -z "$hits" ] && return 0
  echo "::error::publication guard: $1"
  echo "$hits"
  echo ""
  fail=1
}

report "the tooling a finding came from leaked into the generated API reference:" \
  "$(grep -rniE "$METHOD" "$API_DIR" 2>/dev/null)"
report "an internal source path leaked into the generated API reference:" \
  "$(grep -rnE "$INTERNAL_PATH" "$API_DIR" 2>/dev/null)"

if [ "$fail" -ne 0 ]; then
  echo "Reword the JSDoc, or tag the member @internal so it is not generated. See CONTRIBUTING.md."
  exit 1
fi

echo "docs guard OK — no method references or internal paths in $API_DIR/"
exit 0
