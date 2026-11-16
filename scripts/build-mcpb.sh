#!/usr/bin/env bash
# Packs a built imsg-mcp binary into an MCP Bundle (.mcpb), the one-file install for local
# mode in Claude Desktop: deploy/mcpb/manifest.json plus server/imsg-mcp, validated and
# zipped by the official mcpb CLI. Prints the bundle path and its SHA-256.
#
#   scripts/build-mcpb.sh dist/imsg-mcp out/
#
# The bundle is arm64 only (the manifest can limit platforms, not CPUs). Override the CLI
# with MCPB="..." (default: npx --yes @anthropic-ai/mcpb@2.1.2).
set -euo pipefail
cd "$(dirname "$0")/.."

usage="usage: scripts/build-mcpb.sh <imsg-mcp binary> <output directory>"
binary="${1:?$usage}"
outdir="${2:?$usage}"
read -r -a mcpb <<<"${MCPB:-npx --yes @anthropic-ai/mcpb@2.1.2}"

version="$(jq -r .version package.json)"
manifest_version="$(jq -r .version deploy/mcpb/manifest.json)"
if [ "$version" != "$manifest_version" ]; then
  echo "deploy/mcpb/manifest.json has version $manifest_version, package.json has $version" >&2
  exit 1
fi
if [ "$(lipo -archs "$binary" 2>/dev/null || uname -m)" != "arm64" ]; then
  echo "$binary is not an arm64 binary" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/server" "$outdir"
cp deploy/mcpb/manifest.json "$stage/manifest.json"
cp LICENSE "$stage/LICENSE"
cp "$binary" "$stage/server/imsg-mcp"
chmod 755 "$stage/server/imsg-mcp"

# stdin is closed so the CLI can never wait for an answer; progress goes to stderr.
echo "build-mcpb: validating the manifest with ${mcpb[*]}" >&2
"${mcpb[@]}" validate "$stage/manifest.json" </dev/null >&2
out="$outdir/imsg-mcp-${version}-darwin-arm64.mcpb"
echo "build-mcpb: packing $out" >&2
"${mcpb[@]}" pack "$stage" "$out" </dev/null >/dev/null
echo "$out"
shasum -a 256 "$out" | cut -d' ' -f1
