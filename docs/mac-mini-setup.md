# Mac mini setup

How to prepare an always-on Mac to run `imsg-mcp` unattended. The examples call the bot user `imsgbot`; use any name.

`scripts/host-setup.sh` checks most of this and prints the manual steps. Run it first:

```bash
sudo scripts/host-setup.sh          # report only
sudo scripts/host-setup.sh --apply  # also apply the power settings
```

## 1. The machine

- **macOS 14 or later**, as imsg requires.
- **A dedicated standard (non-admin) user**, `imsgbot`, with **automatic login** (System Settings → Users & Groups → Automatically log in as). Messages and AppleScript need a GUI session, so the server runs as a LaunchAgent in this user's session, not as a system LaunchDaemon.
- **Messages.app** signed in to the Apple ID you chose (see [Open decisions](architecture.md#open-decisions)) and added to **Login Items** for `imsgbot`.
- **SMS (green bubbles):** on the iPhone, Settings → Messages → Text Message Forwarding → turn on this Mac. Without it, only iMessage works.
- **Power:** never sleep, restart after power loss:

  ```bash
  sudo pmset -a sleep 0 disksleep 0 autorestart 1
  ```

- **Screen Sharing** on (System Settings → General → Sharing), for setup and for approving macOS permission prompts.
- **FileVault:** automatic login requires FileVault to be off. That gives unattended recovery after a power cut but leaves message copies unencrypted on disk. Decide deliberately ([Open decisions](architecture.md#open-decisions)).

## 2. Software

```bash
brew install steipete/tap/imsg cloudflared
brew pin imsg        # upgrade imsg deliberately, then run the selftest
```

Keep `cloudflared` on Homebrew's latest; the tunnel is outbound-only, so updates carry little risk.

## 3. Code signing

macOS ties privacy grants (Full Disk Access, Automation) to the **code signature** of the binary. An ad-hoc signature changes on every build and silently drops the grants. Sign every build with the same stable identity:

- **Apple Developer ID** ("Developer ID Application: …") if you have one, or
- **a self-signed code-signing certificate** made on the Mac:
  1. Open Keychain Access → Certificate Assistant → Create a Certificate.
  2. Name: `imsg-mcp local signing`; Identity Type: Self Signed Root; Certificate Type: **Code Signing**.
  3. Create it in the login keychain of the account you build with.
  4. Check it is usable: `security find-identity -v -p codesigning`.

Keep the certificate (export it with its private key to your password manager). If you lose it, the next build has a different signature and you must grant the permissions again.

## 4. Build and install

On the Mac (or any Mac with the same signing identity):

```bash
git clone https://github.com/project-nomos/imsg-mcp.git && cd imsg-mcp
bun install
scripts/build.sh                                   # dist/imsg-mcp
scripts/sign.sh "imsg-mcp local signing"           # or your Developer ID identity
sudo scripts/install.sh --user imsgbot
```

`install.sh`:

- copies the binary to `/usr/local/libexec/imsg-mcp/imsg-mcp`, owned by root (so the bot user cannot replace the program that holds Full Disk Access);
- creates `~imsgbot/Library/Application Support/imsg-mcp/config.toml` (mode 0600) if missing;
- writes `~imsgbot/Library/LaunchAgents/ai.mynomos.imsg-mcp.plist` and loads it into `imsgbot`'s GUI session. Pass `--label` to use a different launchd label.

| Service               | Kind         | Runs as   | Behaviour                                                                                 |
| --------------------- | ------------ | --------- | ----------------------------------------------------------------------------------------- |
| `ai.mynomos.imsg-mcp` | LaunchAgent  | `imsgbot` | `RunAtLoad`, `KeepAlive`, listens on `127.0.0.1:8787` only                                |
| `cloudflared`         | LaunchDaemon | root      | Installed with `cloudflared service install <token>` (see [cloudflare.md](cloudflare.md)) |

## 5. Configure

Edit the config as `imsgbot` (`-H` makes sudo use imsgbot's home):

```bash
sudo -u imsgbot -H nano "/Users/imsgbot/Library/Application Support/imsg-mcp/config.toml"
sudo -u imsgbot -H /usr/local/libexec/imsg-mcp/imsg-mcp check-config
```

At minimum set `access.team_domain`, `access.aud` and `access.people` (see [cloudflare.md](cloudflare.md) for where to find them). Leave `send.enabled = false` for now. Every key is described in [configuration.md](configuration.md).

## 6. Grant macOS permissions

Do this signed in as `imsgbot` (over Screen Sharing). Grant to `/usr/local/libexec/imsg-mcp/imsg-mcp` only:

| Permission            | Where                                                                                                                     | Why                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Full Disk Access      | System Settings → Privacy & Security → Full Disk Access → `+` → press ⌘⇧G and type `/usr/local/libexec/imsg-mcp/imsg-mcp` | imsg reads `~/Library/Messages/chat.db`             |
| Automation → Messages | Prompted the first time the service sends (approve it over Screen Sharing)                                                | `imsg send` drives Messages.app through AppleScript |
| Contacts (optional)   | Prompted when imsg first resolves a name                                                                                  | Shows names instead of numbers                      |

Never grant Full Disk Access to `node`, `python3`, Terminal or your editor for this: that would extend it to every script those programs run. imsg runs as a child of `imsg-mcp`, and macOS attributes a launchd-started child's access to the server binary, so the grant on the binary is what counts.

Restart the service so it picks up the grant, then check health:

```bash
sudo launchctl kickstart -k gui/$(id -u imsgbot)/ai.mynomos.imsg-mcp
curl -s http://127.0.0.1:8788/healthz
```

## 7. Smoke test

```bash
# In a Terminal session as imsgbot (Screen Sharing):
/usr/local/libexec/imsg-mcp/imsg-mcp selftest --launchd --no-send
```

`--launchd` matters: a command started from Terminal is checked against **Terminal's** permissions. With `--launchd`, the selftest runs as a one-shot LaunchAgent, exactly like the service, so it tests the binary's own grants. Once sending is enabled and `selftest.to` is an allowlisted handle that will reply (a second phone, or a friend who agreed), run it without `--no-send`:

```bash
/usr/local/libexec/imsg-mcp/imsg-mcp selftest --launchd
```

It reads a chat (Full Disk Access), sends to the test handle (Automation), waits for the reply through the watch stream, and prints PASS or FAIL per step.

## 8. Recovery checklist

After a power cut, the Mac boots, logs `imsgbot` in automatically, launchd starts `imsg-mcp` and Messages, and `cloudflared` reconnects. Watch the heartbeat to confirm. If FileVault is on, the Mac waits at the unlock screen until someone enters the password.
