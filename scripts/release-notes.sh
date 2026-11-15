#!/usr/bin/env bash
# Prints the CHANGELOG.md notes for one version, without its heading, for the GitHub
# release. Fails when the version has no section or the section is empty.
#
#   scripts/release-notes.sh 0.2.0
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:?usage: scripts/release-notes.sh X.Y.Z}"
notes="$(
  awk -v heading="## [${version}]" '
    index($0, heading) == 1 { on = 1; next }
    on && (/^## \[/ || /^\[[^]]+\]: /) { exit }
    on { print }
  ' CHANGELOG.md | sed -e '/./,$!d'
)"
if [ -z "${notes//[[:space:]]/}" ]; then
  echo "CHANGELOG.md has no notes for ${version}" >&2
  exit 1
fi
printf '%s\n' "$notes"
