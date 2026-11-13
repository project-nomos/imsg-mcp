# Configuration

The config is a TOML file at `~/Library/Application Support/imsg-mcp/config.toml`, owned by the bot user, mode `0600`. Create a starter file with `imsg-mcp init`, check it with `imsg-mcp check-config`. The full annotated example is [`deploy/config.example.toml`](../deploy/config.example.toml).

- **Unknown keys are errors.** A typo such as `send.enable` stops the server from starting instead of being ignored.
- **Reload without a restart:** send `SIGHUP`. If the new file is invalid, the server logs the problem and keeps the previous config. `server.listen`, `server.health_listen`, `imsg.path` and `imsg.db` need a restart.

  ```bash
  # as root, from an admin account
  launchctl kill SIGHUP gui/$(id -u imsgbot)/ai.mynomos.imsg-mcp
  ```

- **Other locations:** `--config <path>`, or the environment variables `IMSG_MCP_CONFIG`, `IMSG_MCP_STATE_DIR` (where `state.db` lives) and `IMSG_MCP_LOG_DIR`.

## `[send]`

| Key                  | Default             | Meaning                                                                                                                                              |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | `false`             | When false, the `send_message` tool is not registered at all.                                                                                        |
| `allowlist`          | `[]`                | Who may be texted: E.164 numbers (`"+14155550123"`), emails, or chat ids (`42`). Empty blocks every send.                                            |
| `max_chars`          | `1000`              | Longest message accepted, in characters, after trimming.                                                                                             |
| `rate`               | `"10/hour, 40/day"` | Sliding-window limits across all clients. Units: second, minute, hour, day (also `5/2h`). Persisted in `state.db`, so a restart does not reset them. |
| `confirm_timeout_ms` | `10000`             | How long to look for the sent message in history before answering `handed_off_unconfirmed`.                                                          |

**Allowlist rules.** A direct send (`to`) needs that handle on the list. A chat send (`chat_id`) needs either the chat id on the list, or **every** participant on the list. Listing members (rather than the chat id) means adding a stranger to the group blocks sends to it. Numbers must be E.164 with the country code; `"(415) 555-0123"` and `"14155550123"` are rejected so nothing matches by accident.

## `[read]`

| Key                | Default | Meaning                                                                                                                                                                                                                        |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scope`            | `"all"` | `"all"`, or a list of chat ids, chat identifiers or GUIDs, and handles the assistant may read.                                                                                                                                 |
| `max_text_chars`   | `4000`  | Message text longer than this is cut off and marked `truncated: true`.                                                                                                                                                         |
| `max_result_chars` | `60000` | Largest tool result, in characters. Claude cuts off results above about 150,000 characters on claude.ai and Desktop (25,000 tokens in Claude Code), so bigger pages are trimmed and the cursor continues from where they stop. |

A handle in `scope` (for example `"+14155550123"`) allows the 1:1 chat with that person only. Group chats must be listed by chat id (from `list_chats`) or GUID, so adding someone to a group never widens what can be read. Chats outside the scope never appear in results, and their new messages are dropped before they are stored.

```toml
[read]
scope = [42, 57, "+14155550123", "partner@example.com"]
```

## `[access]` (remote mode)

| Key                       | Default | Meaning                                                                                      |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `team_domain`             | none    | Your Zero Trust team domain, e.g. `"yourteam.cloudflareaccess.com"`.                         |
| `aud`                     | `[]`    | AUD tag of each Access application in front of the server (people and machines).             |
| `people`                  | `[]`    | Emails given the `full` role. In the original single-owner design this is just your address. |
| `service_tokens`          | `{}`    | Table of service token client id to role: `"read"` or `"read_send"`.                         |
| `clock_tolerance_seconds` | `10`    | Allowed clock skew when checking token times.                                                |

`imsg-mcp serve` refuses to start without `team_domain`, at least one `aud`, and at least one person or service token. Stdio mode does not need them.

## `[server]`

| Key             | Default            | Meaning                                                                     |
| --------------- | ------------------ | --------------------------------------------------------------------------- |
| `listen`        | `"127.0.0.1:8787"` | MCP endpoint (`/mcp`). Must be a loopback address.                          |
| `health_listen` | `"127.0.0.1:8788"` | `/healthz`. Must be loopback, and must not be published through the tunnel. |

## `[imsg]`

| Key                  | Default  | Meaning                                                                                        |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `path`               | `"imsg"` | The imsg binary. A bare name is looked up in `PATH`, `/opt/homebrew/bin` and `/usr/local/bin`. |
| `db`                 | `""`     | Optional `chat.db` path, passed as `imsg rpc --db`.                                            |
| `call_timeout_ms`    | `10000`  | Timeout for each imsg call.                                                                    |
| `restart_initial_ms` | `1000`   | First restart delay after the child exits.                                                     |
| `restart_max_ms`     | `30000`  | Restart delays double up to this.                                                              |

## `[store]`, `[logging]`

| Key                             | Default  | Meaning                                              |
| ------------------------------- | -------- | ---------------------------------------------------- |
| `store.retention_days`          | `14`     | Days to keep inbound messages in `state.db`.         |
| `logging.level`                 | `"info"` | `debug`, `info`, `warn` or `error` for `server.log`. |
| `logging.server_retention_days` | `14`     | Days of rotated `server.log` files to keep.          |
| `logging.audit_retention_days`  | `90`     | Days of rotated `audit.jsonl` files to keep.         |

## `[heartbeat]`, `[health]`

| Key                                      | Default | Meaning                                                                                                         |
| ---------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `heartbeat.url`                          | `""`    | Dead-man's switch URL (e.g. a Healthchecks.io ping URL). Requested with `GET` while healthy. Empty disables it. |
| `heartbeat.interval_seconds`             | `300`   | How often to ping.                                                                                              |
| `health.sync_check_interval_seconds`     | `600`   | How often to compare the watch with the database.                                                               |
| `health.messages_check_interval_seconds` | `60`    | How often to check that Messages.app is running.                                                                |
| `health.relaunch_messages`               | `true`  | Open Messages.app when it is not running, and retry a failed send once.                                         |

## `[local]`, `[selftest]`

| Key                              | Default  | Meaning                                                                                              |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `local.role`                     | `"full"` | Role of the caller in stdio mode. Use `"read"` for a read-only local setup. Takes effect on restart. |
| `selftest.to`                    | `""`     | Allowlisted handle that `imsg-mcp selftest` texts. Have it reply to finish the test.                 |
| `selftest.reply_timeout_seconds` | `120`    | How long the selftest waits for that reply.                                                          |

## Roles

| Role        | Who                                                     | Can read | Can send                          |
| ----------- | ------------------------------------------------------- | -------- | --------------------------------- |
| `full`      | People in `access.people`; the local user in stdio mode | Yes      | When `send.enabled`               |
| `read_send` | Service tokens you mark so                              | Yes      | When `send.enabled`               |
| `read`      | Service tokens by default                               | Yes      | No (`send_message` is not listed) |

## Example: read-only first, then sending

```toml
[access]
team_domain = "yourteam.cloudflareaccess.com"
aud = ["4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2"]
people = ["you@example.com"]

[send]
enabled = false   # flip to true after the acceptance checklist passes
allowlist = ["+14155550123", 42]

[heartbeat]
url = "https://hc-ping.com/your-check-uuid"
```
