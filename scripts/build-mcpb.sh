#!/usr/bin/env bash
# Packs a built imsg-mcp binary into an MCP Bundle (.mcpb), the one-file install for local
# mode in Claude Desktop: deploy/mcpb/manifest.json plus server/imsg-mcp, validated by the
# official mcpb CLI and zipped. Prints the bundle path and its SHA-256.
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

# A bundle is a zip with manifest.json at the top, Unix permissions kept, and no entries
# for folders (mcpb's unpacker would try to write them as files), which is what
# "mcpb pack" makes. Info-ZIP builds the same archive: "mcpb pack" compresses the 90 MB
# binary in JavaScript and stalled for minutes to hours on GitHub's runners.
out="$outdir/imsg-mcp-${version}-darwin-arm64.mcpb"
out_abs="$(cd "$outdir" && pwd)/$(basename "$out")"
rm -f "$out_abs"
echo "build-mcpb: packing $out" >&2
(cd "$stage" && zip -q -X -D -r -9 "$out_abs" manifest.json LICENSE server)
listing="$(unzip -Z "$out_abs")"
if grep -q '^d' <<<"$listing"; then
  echo "build-mcpb: $out has folder entries" >&2
  exit 1
fi
for entry in manifest.json LICENSE server/imsg-mcp; do
  grep -q " ${entry}\$" <<<"$listing" || { echo "build-mcpb: $entry is missing from $out" >&2; exit 1; }
done
grep -q '^-rwxr-xr-x .* server/imsg-mcp$' <<<"$listing" || {
  echo "build-mcpb: server/imsg-mcp lost its executable bit in $out" >&2
  exit 1
}
echo "$out"
shasum -a 256 "$out" | cut -d' ' -f1
