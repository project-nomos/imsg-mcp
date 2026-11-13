#!/usr/bin/env bash
# Swaps in a new imsg-mcp binary and restarts the service, keeping macOS privacy grants.
#
#   sudo scripts/update.sh --user imsgbot [--binary dist/imsg-mcp] [--label ai.mynomos.imsg-mcp]
#
# Grants survive only if the new binary's designated requirement (its signing identity)
# matches the installed one, so this refuses a mismatch unless you pass --force.
set -euo pipefail

INSTALLED="/usr/local/libexec/imsg-mcp/imsg-mcp"
LABEL="ai.mynomos.imsg-mcp"
SRC_BINARY="dist/imsg-mcp"
BOT_USER=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) BOT_USER="${2:-}"; shift 2 ;;
    --binary) SRC_BINARY="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "error: run with sudo" >&2; exit 1; }
[[ -n "$BOT_USER" ]] || { echo "error: --user is required" >&2; exit 64; }
[[ -f "$INSTALLED" ]] || { echo "error: $INSTALLED is not installed; use scripts/install.sh" >&2; exit 1; }
codesign --verify --strict "$SRC_BINARY" || { echo "error: $SRC_BINARY is not validly signed" >&2; exit 1; }

requirement() { codesign -d -r- "$1" 2>&1 | sed -n 's/^#* *designated => //p'; }
old_req="$(requirement "$INSTALLED")"
new_req="$(requirement "$SRC_BINARY")"
if [[ "$old_req" != "$new_req" ]]; then
  echo "The new binary is signed differently from the installed one:" >&2
  echo "  installed: $old_req" >&2
  echo "  new:       $new_req" >&2
  echo "macOS will drop Full Disk Access and Automation for it." >&2
  if [[ $FORCE -ne 1 ]]; then
    echo "Sign it with the same identity (scripts/sign.sh), or pass --force and re-grant afterwards." >&2
    exit 1
  fi
fi

echo "==> Installed: $("$INSTALLED" version 2>/dev/null || echo unknown)  New: $("$SRC_BINARY" version)"
install -m 0755 -o root -g wheel "$SRC_BINARY" "$INSTALLED.new"
mv -f "$INSTALLED.new" "$INSTALLED"

BOT_UID="$(id -u "$BOT_USER")"
echo "==> Restarting gui/$BOT_UID/$LABEL"
launchctl kickstart -k "gui/$BOT_UID/$LABEL"
sleep 3
if curl -fsS http://127.0.0.1:8788/healthz >/dev/null 2>&1; then
  echo "    healthy"
else
  echo "    not healthy yet; check: curl -s http://127.0.0.1:8788/healthz" >&2
fi
echo "Run the smoke test as $BOT_USER (Screen Sharing): $INSTALLED selftest --launchd"
