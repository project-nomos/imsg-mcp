#!/usr/bin/env bash
# Builds imsg-mcp into one self-contained binary with `bun build --compile`.
#
#   scripts/build.sh                 # dist/imsg-mcp for this Mac's CPU
#   TARGET=bun-darwin-x64 scripts/build.sh
#
# Sign the result with scripts/sign.sh before installing it.
set -euo pipefail
cd "$(dirname "$0")/.."

case "$(uname -m)" in
  arm64) default_target="bun-darwin-arm64" ;;
  *) default_target="bun-darwin-x64" ;;
esac
TARGET="${TARGET:-$default_target}"
OUT="${OUT:-dist/imsg-mcp}"

mkdir -p "$(dirname "$OUT")"
bun build src/cli.ts --compile --minify --sourcemap --target="$TARGET" --outfile "$OUT"
echo "Built $OUT for $TARGET ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
"$OUT" version >/dev/null 2>&1 && echo "Smoke check: $("$OUT" version)" || true
