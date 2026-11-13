#!/usr/bin/env bash
# Stops and removes the imsg-mcp LaunchAgent and binary.
#
#   sudo scripts/uninstall.sh --user imsgbot [--label ai.mynomos.imsg-mcp] [--purge]
#
# --purge also deletes the config, state.db (stored messages) and logs (including the audit log).
set -euo pipefail

LABEL="ai.mynomos.imsg-mcp"
BOT_USER=""
PURGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) BOT_USER="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "error: run with sudo" >&2; exit 1; }
[[ -n "$BOT_USER" ]] || { echo "error: --user is required" >&2; exit 64; }

BOT_UID="$(id -u "$BOT_USER")"
BOT_HOME="$(dscl . -read "/Users/$BOT_USER" NFSHomeDirectory | awk '{print $2}')"
launchctl bootout "gui/$BOT_UID/$LABEL" 2>/dev/null || true
rm -f "$BOT_HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf /usr/local/libexec/imsg-mcp
echo "Removed the LaunchAgent and binary."
if [[ $PURGE -eq 1 ]]; then
  rm -rf "$BOT_HOME/Library/Application Support/imsg-mcp" "$BOT_HOME/Library/Logs/imsg-mcp"
  echo "Removed config, state and logs."
else
  echo "Kept config, state and logs (use --purge to delete them)."
fi
echo "Privacy grants for the old binary can be removed in System Settings > Privacy & Security."
