#!/usr/bin/env bash
# Writes the MCP Registry entry (server.json) for a release: the .mcpb bundle attached to
# the GitHub release, with its SHA-256. The Release workflow publishes it with
# mcp-publisher; `mcp-publisher validate` checks it locally.
#
#   scripts/server-json.sh 0.2.0 <sha256 of the .mcpb> > server.json
set -euo pipefail
cd "$(dirname "$0")/.."

usage="usage: scripts/server-json.sh X.Y.Z <mcpb sha256>"
version="${1:?$usage}"
sha256="${2:?$usage}"
if ! [[ "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "not a SHA-256: $sha256" >&2
  exit 1
fi
repo="https://github.com/project-nomos/imsg-mcp"

jq -n \
  --arg version "$version" \
  --arg url "${repo}/releases/download/v${version}/imsg-mcp-${version}-darwin-arm64.mcpb" \
  --arg sha256 "$sha256" \
  --arg repo "$repo" \
  '{
    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "io.github.project-nomos/imsg-mcp",
    title: "imsg-mcp",
    description: "iMessage and SMS for AI assistants, from a Mac you control. Read, search, send with approval.",
    repository: { url: $repo, source: "github" },
    websiteUrl: $repo,
    version: $version,
    packages: [
      {
        registryType: "mcpb",
        identifier: $url,
        fileSha256: $sha256,
        transport: { type: "stdio" }
      }
    ]
  }'
