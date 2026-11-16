#!/usr/bin/env bash
# Prints the version the next release gets, worked out from CHANGELOG.md's Unreleased
# section and the current version in package.json:
#
#   entries under Added, Changed, Deprecated or Removed   next minor (0.2.0 -> 0.3.0)
#   entries only under Fixed or Security                  next patch (0.2.0 -> 0.2.1)
#   no entries                                            nothing (no release)
#
# A major version is never picked automatically: run the Release workflow by hand with
# its "version" input for that.
#
#   scripts/next-version.sh            # prints e.g. 0.2.0, or nothing
set -euo pipefail
cd "$(dirname "$0")/.."

current="$(jq -r .version package.json)"
if ! [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "package.json has version \"$current\", which is not X.Y.Z" >&2
  exit 1
fi
major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"

# Only top-level bullets count; indented lines continue the bullet above them.
level="$(awk '
  /^## \[Unreleased\]/ { on = 1; next }
  on && (/^## \[/ || /^\[[^]]+\]: /) { exit }
  on && /^### / { section = tolower($2); next }
  on && /^[-*] / { if (section == "fixed" || section == "security") fixes = 1; else changes = 1 }
  END { if (changes) print "minor"; else if (fixes) print "patch" }
' CHANGELOG.md)"

case "$level" in
  minor) echo "${major}.$((minor + 1)).0" ;;
  patch) echo "${major}.${minor}.$((patch + 1))" ;;
  *) ;;
esac
