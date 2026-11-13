# Troubleshooting

Start with the two sources of truth:

```bash
curl -s http://127.0.0.1:8788/healthz | jq .            # on the Mac
tail -n 50 ~/Library/Logs/imsg-mcp/server.log | jq -c '{time, level, msg, error}'
```

and the `get_status` tool from any client.

## Tools say "grant Full Disk Access"

`imsg` cannot read `~/Library/Messages/chat.db`.

- Grant Full Disk Access to `/usr/local/libexec/imsg-mcp/imsg-mcp` (not to Terminal), signed in as the bot user. See [mac-mini-setup.md](mac-mini-setup.md#6-grant-macos-permissions).
- If it was granted before, the binary's signature probably changed (an ad-hoc signed build, or a different identity). Run `codesign -dv /usr/local/libexec/imsg-mcp/imsg-mcp` and compare. Remove the stale entry in the Full Disk Access list and add the binary again.
- The server restarts imsg at most once a minute to notice a new grant; or restart the agent with `launchctl kickstart -k`.
- In **local mode**, the grant must be on the client app (Claude Desktop, or your terminal or editor), because macOS attributes the server to whatever launched it.

## The selftest passes in Terminal but the service has no access (or the reverse)

Run the selftest with `--launchd`. Without it, macOS checks Terminal's permissions, not the binary's.

## Sends fail or come back `handed_off_unconfirmed`

- **Automation:** the first send triggers "imsg-mcp wants to control Messages". Approve it over Screen Sharing. If you denied it, re-enable it under System Settings → Privacy & Security → Automation.
- **Messages signed out** or waiting for Apple ID re-authentication: open Messages over Screen Sharing.
- **SMS numbers:** the iPhone must have Text Message Forwarding on for this Mac.
- `handed_off_unconfirmed` means Messages accepted the text but it did not show up in history within `send.confirm_timeout_ms`. Check `get_messages` for that chat before sending again.
- An error saying the outcome is unknown is never retried automatically. Check `get_messages` first.

## "Send refused by rule …"

That is the server working as designed:

- **rule 1 (role):** the caller is a `read` service token.
- **rule 2 (allowlist):** add the E.164 number or email to `send.allowlist`. For a group, either list its chat id or list every member. Numbers need the `+` and country code.
- **rule 3 (length):** empty or longer than `send.max_chars`.
- **rule 4 (rate):** wait until the time in the message, or raise `send.rate` deliberately.

## `send_message` is missing from the tool list

- `send.enabled` is false (check with `imsg-mcp check-config`), or
- the caller's role is `read`, or
- the client cached an older tool list: reconnect it. (Remote mode builds the tool list per request; local mode notifies the client on reload.)

## Claude cannot connect or keeps asking to sign in

- `curl -si https://imsg.example.com/mcp` must return `401` with a `WWW-Authenticate` header. A `302` means **Managed OAuth** is off on the people application.
- The redirect URI `https://claude.ai/api/mcp/auth_callback` must be allowed; for Claude Code, **Allow loopback clients** and **Allow localhost clients** must be on.
- `403` from the origin (visible in `server.log` as `request rejected` with a reason):
  - `claim "aud" invalid`: the application's AUD tag is not in `access.aud`.
  - `claim "iss" invalid`: `access.team_domain` does not match your team domain.
  - `email not in access.people` / `service token not in access.service_tokens`: add the identity.
  - `token expired`: check the Mac's clock (`sntp -sS time.apple.com`).

## `check_new_messages` returns nothing new

- `get_status` → `watch.subscribed` should be true and `watch.cursor` should move as texts arrive.
- `read.scope` might exclude the chat.
- Only **inbound** messages are returned; your own sends are not.
- If the warning says `since_cursor` is ahead of the database, call once without `since_cursor` to resync (this happens after chat.db is replaced).
- If `get_status` (or `server.log`) says the saved cursor is far ahead of the newest message and chat.db really was replaced (a new Mac or a restore), stop the server, delete `~/Library/Application Support/imsg-mcp/state.db`, and start it again. The server never does this on its own, because iCloud downloading old history looks the same from the outside.
- History that iCloud downloads onto a newly set-up Mac is not reported as new when it is older than `store.retention_days` (14 days). Newer synced history can show up once; let iCloud finish syncing before you connect agents.

## The server will not start

`~/Library/Logs/imsg-mcp/launchd.err.log` has the reason. Common ones:

| Exit | Meaning                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| 78   | Config problem: the message lists each one (unknown key, non-loopback address, missing `access` settings). |
| 69   | imsg missing or too old: `imsg-mcp check-config` shows which RPC methods are missing.                      |
| 64   | Bad command-line arguments.                                                                                |

`launchctl print gui/$(id -u imsgbot)/ai.mynomos.imsg-mcp` shows whether launchd is throttling restarts.

## Search misses older messages

With imsg older than 0.14, `search_messages` without `chat_id` only scans the newest messages of the most recent chats (the result's `searched` field says so). Pass `chat_id`, or upgrade imsg for full-database search.
