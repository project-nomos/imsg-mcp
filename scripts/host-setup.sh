#!/usr/bin/env bash
# Prepares a Mac to run imsg-mcp unattended, and prints the steps that need a person.
#
#   sudo scripts/host-setup.sh            # show what would change
#   sudo scripts/host-setup.sh --apply    # apply the power settings
set -euo pipefail
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

echo "macOS $(sw_vers -productVersion) on $(uname -m)"
major="$(sw_vers -productVersion | cut -d. -f1)"
if (( major < 14 )); then
  echo "warning: imsg needs macOS 14 or later" >&2
fi

echo
echo "Power: never sleep, restart after power loss"
if [[ $APPLY -eq 1 ]]; then
  [[ $EUID -eq 0 ]] || { echo "error: --apply needs sudo" >&2; exit 1; }
  pmset -a sleep 0 disksleep 0 autorestart 1
  pmset -g | grep -E ' (sleep|disksleep|autorestart) '
else
  echo "  would run: pmset -a sleep 0 disksleep 0 autorestart 1"
  pmset -g | grep -E ' (sleep|disksleep|autorestart) ' || true
fi

echo
echo "FileVault: $(fdesetup status 2>/dev/null || echo unknown)"
echo "  With FileVault on, the Mac waits for a password after every reboot, so it cannot"
echo "  recover from a power cut on its own. See 'Open decisions' in docs/architecture.md."

echo
echo "Software:"
for tool in imsg cloudflared; do
  if command -v "$tool" >/dev/null 2>&1 || [[ -x "/opt/homebrew/bin/$tool" ]]; then
    echo "  $tool: installed"
  else
    echo "  $tool: missing (brew install $([[ $tool == imsg ]] && echo steipete/tap/imsg || echo cloudflared))"
  fi
done

cat <<'STEPS'

Manual steps (docs/mac-mini-setup.md has the details):
  [ ] Create a standard (non-admin) user for the bot, e.g. imsgbot
  [ ] System Settings > Users & Groups > Automatically log in as: imsgbot  (FileVault must be off)
  [ ] As imsgbot: sign in to Messages; add Messages to Login Items
  [ ] On the iPhone: Settings > Messages > Text Message Forwarding > enable this Mac (for SMS)
  [ ] System Settings > General > Sharing > Screen Sharing: on (for remote setup and grants)
  [ ] brew install steipete/tap/imsg cloudflared oven-sh/bun/bun && brew pin steipete/tap/imsg
  [ ] Build, sign and install imsg-mcp: scripts/build.sh, scripts/sign.sh, sudo scripts/install.sh --user imsgbot
  [ ] Grant the binary Full Disk Access and Automation > Messages (as imsgbot)
  [ ] Cloudflare (docs/cloudflare.md): cloudflared tunnel login, tunnel create, route dns;
      then the Access application; then load the tunnel LaunchAgent
STEPS
