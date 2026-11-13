#!/usr/bin/env bash
# Installs imsg-mcp on the Mac that runs Messages.
#
#   sudo scripts/install.sh --user imsgbot [--binary dist/imsg-mcp] [--label ai.mynomos.imsg-mcp]
#
# What it does:
#   1. Copies the signed binary to /usr/local/libexec/imsg-mcp/imsg-mcp (root-owned, so the
#      bot user cannot swap the program that holds Full Disk Access).
#   2. Creates the bot user's config (mode 0600) if there is none yet.
#   3. Writes ~/Library/LaunchAgents/<label>.plist for the bot user and loads it into that
#      user's GUI session (the user must be logged in, e.g. via automatic login).
#
# It does not grant macOS privacy permissions; see docs/mac-mini-setup.md.
set -euo pipefail

INSTALL_DIR="/usr/local/libexec/imsg-mcp"
BINARY_NAME="imsg-mcp"
LABEL="ai.mynomos.imsg-mcp"
SRC_BINARY="dist/imsg-mcp"
BOT_USER=""

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) BOT_USER="${2:-}"; shift 2 ;;
    --binary) SRC_BINARY="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || { echo "error: macOS only" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "error: run with sudo" >&2; exit 1; }
[[ -n "$BOT_USER" ]] || { echo "error: --user is required (the macOS user that runs Messages)" >&2; exit 64; }
id "$BOT_USER" >/dev/null 2>&1 || { echo "error: no such user: $BOT_USER" >&2; exit 67; }
[[ -f "$SRC_BINARY" ]] || { echo "error: $SRC_BINARY not found; run scripts/build.sh and scripts/sign.sh" >&2; exit 66; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/../deploy/launchd/ai.mynomos.imsg-mcp.plist"
BOT_UID="$(id -u "$BOT_USER")"
BOT_HOME="$(dscl . -read "/Users/$BOT_USER" NFSHomeDirectory | awk '{print $2}')"
BINARY="$INSTALL_DIR/$BINARY_NAME"

echo "==> Checking the signature"
if ! codesign --verify --strict "$SRC_BINARY" 2>/dev/null; then
  echo "error: $SRC_BINARY is not validly signed; run scripts/sign.sh first" >&2
  exit 1
fi
if codesign -dv "$SRC_BINARY" 2>&1 | grep -q "flags=.*adhoc"; then
  echo "warning: ad-hoc signature. Full Disk Access will be lost on every update." >&2
fi

echo "==> Installing $BINARY"
mkdir -p "$INSTALL_DIR"
install -m 0755 -o root -g wheel "$SRC_BINARY" "$BINARY"

echo "==> Preparing $BOT_USER's config, state and log directories"
APP_SUPPORT="$BOT_HOME/Library/Application Support/imsg-mcp"
LOG_DIR="$BOT_HOME/Library/Logs/imsg-mcp"
sudo -u "$BOT_USER" mkdir -p "$APP_SUPPORT" "$LOG_DIR" "$BOT_HOME/Library/LaunchAgents"
chmod 700 "$APP_SUPPORT" "$LOG_DIR"
if [[ ! -f "$APP_SUPPORT/config.toml" ]]; then
  sudo -u "$BOT_USER" -H "$BINARY" init
else
  echo "    keeping existing $APP_SUPPORT/config.toml"
fi
chmod 600 "$APP_SUPPORT/config.toml"

echo "==> Writing the LaunchAgent ($LABEL)"
PLIST="$BOT_HOME/Library/LaunchAgents/$LABEL.plist"
sed -e "s|__LABEL__|$LABEL|g" -e "s|__BINARY__|$BINARY|g" -e "s|__HOME__|$BOT_HOME|g" "$TEMPLATE" > "$PLIST"
chown "$BOT_USER" "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null

echo "==> Loading it into $BOT_USER's GUI session"
if launchctl print "gui/$BOT_UID" >/dev/null 2>&1; then
  launchctl bootout "gui/$BOT_UID/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$BOT_UID" "$PLIST"
  launchctl enable "gui/$BOT_UID/$LABEL"
  echo "    loaded; status: launchctl print gui/$BOT_UID/$LABEL"
else
  echo "    $BOT_USER is not logged in. It will start at their next login (turn on automatic login)."
fi

cat <<NEXT

Installed. Next steps (details in docs/mac-mini-setup.md):
  1. Edit $APP_SUPPORT/config.toml (access.team_domain, access.aud, access.people),
     then: sudo -u $BOT_USER -H $BINARY check-config
  2. Signed in as $BOT_USER (Screen Sharing), grant $BINARY:
       System Settings > Privacy & Security > Full Disk Access
       System Settings > Privacy & Security > Automation > Messages (prompted on first send)
  3. Restart it: launchctl kickstart -k gui/$BOT_UID/$LABEL
  4. Check health: curl -s http://127.0.0.1:8788/healthz
  5. Smoke test (as $BOT_USER, over Screen Sharing): $BINARY selftest --launchd --no-send
NEXT
