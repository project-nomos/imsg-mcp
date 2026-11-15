#!/usr/bin/env bash
# Prepares a release: sets the version in package.json, both plugin manifests and the
# bundle manifest, and moves CHANGELOG.md's Unreleased notes under a heading for it.
# Commit the result and push it to main; the Release workflow does the rest.
#
#   scripts/bump-version.sh 0.2.0
set -euo pipefail
cd "$(dirname "$0")/.."

new="${1:?usage: scripts/bump-version.sh X.Y.Z}"
if ! [[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "not a version: $new" >&2
  exit 64
fi
old="$(jq -r .version package.json)"
if [ "$new" = "$old" ]; then
  echo "already at $new" >&2
  exit 64
fi
if [ "$(printf '%s\n%s\n' "$old" "$new" | sort -V | tail -1)" != "$new" ]; then
  echo "$new is not newer than $old" >&2
  exit 64
fi

# The Unreleased section must have notes to release.
unreleased="$(awk '
  /^## \[Unreleased\]/ { on = 1; next }
  on && /^## \[/ { exit }
  on { print }
' CHANGELOG.md)"
if [ -z "${unreleased//[[:space:]]/}" ]; then
  echo "CHANGELOG.md has nothing under Unreleased" >&2
  exit 65
fi

# Replace only the version line, so the files keep their formatting.
for f in package.json plugins/imsg-mcp/plugin.json plugins/imsg-mcp/.claude-plugin/plugin.json deploy/mcpb/manifest.json; do
  perl -0pi -e 's/^(\s*"version":\s*)"\Q'"$old"'\E"/${1}"'"$new"'"/m' "$f"
  if [ "$(jq -r .version "$f")" != "$new" ]; then
    echo "could not update the version in $f" >&2
    exit 1
  fi
done

date="$(date -u +%Y-%m-%d)"
repo="https://github.com/project-nomos/imsg-mcp"
NEW="$new" DATE="$date" REPO="$repo" perl -0pi -e '
  s/^## \[Unreleased\]\n/## [Unreleased]\n\n## [$ENV{NEW}] - $ENV{DATE}\n/m;
  s{^\[Unreleased\]: \S+$}{[Unreleased]: $ENV{REPO}/compare/v$ENV{NEW}...HEAD\n[$ENV{NEW}]: $ENV{REPO}/releases/tag/v$ENV{NEW}}m;
' CHANGELOG.md

echo "Version $old -> $new. Review CHANGELOG.md, then commit and push to main to release."
