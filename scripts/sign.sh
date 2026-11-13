#!/usr/bin/env bash
# Signs the imsg-mcp binary with a stable identity.
#
# macOS ties Full Disk Access and Automation grants to the code signature. An ad-hoc
# signature changes on every build, so the grants silently disappear; a stable identity
# (Developer ID, or a self-signed code-signing certificate on this Mac) keeps them.
#
#   scripts/sign.sh "Developer ID Application: Your Name (TEAMID)" [dist/imsg-mcp]
#   scripts/sign.sh "imsg-mcp local signing" [dist/imsg-mcp]        # self-signed
#   IMSG_MCP_SIGN_IDENTITY="..." scripts/sign.sh
#
# List the identities you have:  security find-identity -v -p codesigning
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${1:-${IMSG_MCP_SIGN_IDENTITY:-}}"
BIN="${2:-dist/imsg-mcp}"
IDENTIFIER="${IMSG_MCP_SIGN_ID:-ai.mynomos.imsg-mcp}"
ENTITLEMENTS="deploy/entitlements.plist"

if [[ -z "$IDENTITY" ]]; then
  echo "usage: scripts/sign.sh <signing identity> [binary]" >&2
  echo "Available code-signing identities:" >&2
  security find-identity -v -p codesigning >&2 || true
  exit 64
fi
if [[ ! -f "$BIN" ]]; then
  echo "error: $BIN not found; run scripts/build.sh first" >&2
  exit 66
fi
if [[ "$IDENTITY" == "-" ]]; then
  echo "warning: ad-hoc signature. macOS will drop Full Disk Access after every rebuild." >&2
fi

timestamp="--timestamp=none"
if [[ "$IDENTITY" == Developer\ ID* ]]; then
  timestamp="--timestamp"
fi

codesign --force --sign "$IDENTITY" --identifier "$IDENTIFIER" \
  --options runtime --entitlements "$ENTITLEMENTS" "$timestamp" "$BIN"
codesign --verify --strict --verbose=2 "$BIN"
echo
codesign -dv "$BIN" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Runtime Version|CodeDirectory)' || true
echo "Designated requirement (must stay the same across updates to keep privacy grants):"
codesign -d -r- "$BIN" 2>&1 | sed -n 's/^#* *designated => /  /p'
"$BIN" version >/dev/null && echo "Signed binary runs: imsg-mcp $("$BIN" version)"
