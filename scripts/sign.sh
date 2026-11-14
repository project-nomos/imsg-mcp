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
# With an identity from scripts/make-signing-identity.sh (its own keychain, works over SSH):
#   IMSG_MCP_SIGN_KEYCHAIN=~/Library/Keychains/imsg-mcp-signing.keychain-db \
#     scripts/sign.sh "imsg-mcp local signing"
#
# List the identities you have:  security find-identity -v -p codesigning
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${1:-${IMSG_MCP_SIGN_IDENTITY:-}}"
BIN="${2:-dist/imsg-mcp}"
IDENTIFIER="${IMSG_MCP_SIGN_ID:-ai.mynomos.imsg-mcp}"
ENTITLEMENTS="deploy/entitlements.plist"
KEYCHAIN="${IMSG_MCP_SIGN_KEYCHAIN:-}"

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

keychain_args=()
if [[ -n "$KEYCHAIN" ]]; then
  if [[ ! -f "$KEYCHAIN" ]]; then
    echo "error: keychain $KEYCHAIN not found (create it with scripts/make-signing-identity.sh)" >&2
    exit 66
  fi
  passfile="${IMSG_MCP_SIGN_KEYCHAIN_PASSWORD_FILE:-${KEYCHAIN%.keychain-db}.pass}"
  if [[ -f "$passfile" ]]; then
    security unlock-keychain -p "$(cat "$passfile")" "$KEYCHAIN"
  fi
  keychain_args=(--keychain "$KEYCHAIN")
fi

codesign --force --sign "$IDENTITY" ${keychain_args[@]+"${keychain_args[@]}"} \
  --identifier "$IDENTIFIER" --options runtime --entitlements "$ENTITLEMENTS" "$timestamp" "$BIN"
codesign --verify --strict --verbose=2 "$BIN"
echo
codesign -dv "$BIN" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Runtime Version|CodeDirectory)' || true
echo "Designated requirement (must stay the same across updates to keep privacy grants):"
codesign -d -r- "$BIN" 2>&1 | sed -n 's/^#* *designated => /  /p'
"$BIN" version >/dev/null && echo "Signed binary runs: imsg-mcp $("$BIN" version)"
