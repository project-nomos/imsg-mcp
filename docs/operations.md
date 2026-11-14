# Operations

The Mac mini sits alone, so it should say when it is unhealthy. The server sends an outbound heartbeat every 5 minutes while healthy; a missed heartbeat triggers an alert through a dead-man's-switch service such as [Healthchecks.io](https://healthchecks.io).

## Health

`GET http://127.0.0.1:8788/healthz` on a second loopback port, kept out of the tunnel. It returns `200` when healthy and `503` otherwise, with details either way:

```json
{
  "healthy": true,
  "problems": [],
  "imsg": {
    "version": "0.8.2",
    "child_alive": true,
    "pid": 4120,
    "restarts": 0,
    "last_exit": null
  },
  "messages_app_running": true,
  "watch": {
    "subscribed": true,
    "in_sync": true,
    "cursor": 918240,
    "seconds_since_last_event": 312,
    "last_inbound_at": "2026-11-13T18:09:30.551Z",
    "sync": { "checked_at": "…", "db_newest_rowid": 918240, "behind": false, "resubscribes": 0 }
  },
  "last_history_ok_at": "2026-11-13T18:10:02.104Z",
  "heartbeat": {
    "configured": true,
    "last_sent_at": "2026-11-13T18:10:00.000Z",
    "last_error": null
  }
}
```

**Healthy** means the `imsg` child is up, Messages.app is running, and the watch is subscribed and in sync. Only then is the heartbeat sent. A quiet stretch with no new messages is normal; `seconds_since_last_event` is informational.

Background checks:

| Check                | Every  | Action                                                                                                                                |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Messages.app running | 60 s   | If not, `open -g -a Messages` (at most every 5 minutes)                                                                               |
| Watch sync           | 10 min | Compare the newest rowid in `messages.history` with the last one watched; if the database is ahead, resubscribe from the saved cursor |
| Heartbeat            | 5 min  | `GET heartbeat.url` while healthy                                                                                                     |
| Retention            | 1 h    | Delete inbound messages older than 14 days                                                                                            |

### Setting up the heartbeat

1. Create a check at Healthchecks.io (or any service that alerts on a missed ping) with a 5-minute period and a 10-minute grace.
2. Put its ping URL in the config:

   ```toml
   [heartbeat]
   url = "https://hc-ping.com/your-check-uuid"
   ```

3. Reload (`SIGHUP`) and confirm `heartbeat.last_sent_at` in `/healthz` within a few minutes.

## Logs

`~/Library/Logs/imsg-mcp/` of the bot user:

| File                                 | Contents                                                                                                    | Rotation          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------- |
| `server.log`                         | JSON lines: startup, requests (identity, status, duration), restarts, warnings. No message text, no tokens. | Daily, 14 days    |
| `audit.jsonl`                        | One record per tool call; sends in full. See [security.md](security.md#audit-log).                          | Daily, 90 days    |
| `launchd.out.log`, `launchd.err.log` | Anything printed before logging starts (bad config, crash).                                                 | Not rotated; tiny |

Rotated files are named `server.YYYY-MM-DD.log` and `audit.YYYY-MM-DD.jsonl`.

```bash
tail -f ~/Library/Logs/imsg-mcp/server.log | jq -c '{time, level, msg}'
jq -c 'select(.tool == "send_message")' ~/Library/Logs/imsg-mcp/audit.jsonl
```

## Failure modes

| Failure                                               | How you notice                                                                             | Recovery                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imsg` child crashes                                  | Child exit in `server.log`                                                                 | Automatic restart with backoff (1 s doubling to 30 s); the watch resubscribes from the cursor                                                           |
| Messages.app quits                                    | `/healthz`, a failed send                                                                  | The server runs `open -a Messages`; a send that failed because of it is retried once                                                                    |
| Full Disk Access lost after a rebuild or macOS update | Tool errors mention Full Disk Access; heartbeat stops                                      | Re-grant to the signed binary over Screen Sharing; the server restarts imsg to pick it up                                                               |
| Messages signed out or asking for Apple ID re-auth    | Failed sends; heartbeat may stop                                                           | Sign in again over Screen Sharing                                                                                                                       |
| Power outage                                          | Heartbeat gap                                                                              | Auto-restart and automatic login bring everything back (blocked if FileVault is on)                                                                     |
| Tunnel down                                           | Tunnel status in the Zero Trust dashboard; heartbeat continues (it is outbound)            | `cloudflared` restarts itself                                                                                                                           |
| Watch falls behind                                    | Sync check (`watch.sync.behind`, warning in `server.log`)                                  | Automatic resubscribe from the saved cursor                                                                                                             |
| `imsg` child stops answering                          | Calls time out; `consecutive_timeouts` in `/healthz`                                       | Killed and restarted after three timeouts in a row                                                                                                      |
| A row cannot be written to `state.db` (disk full)     | `watch notification failed` in `server.log`; watch not subscribed                          | Cursor stays put; resubscribes with a growing delay until the write succeeds, then replays the row                                                      |
| Sync check fails                                      | `/healthz` reports `sync check failed`; heartbeat stops                                    | Retried after a minute; healthy again once a check succeeds                                                                                             |
| chat.db replaced (new Mac, restore)                   | Warning "saved cursor is far ahead of the newest message" in `server.log` and `get_status` | Stop the server, delete `state.db`, start it (it backfills the last 24 hours). Never done automatically, because iCloud history downloads look the same |

## Updates

- **imsg:**

  ```bash
  brew unpin steipete/tap/imsg && brew upgrade steipete/tap/imsg
  sudo launchctl kickstart -k gui/$(id -u imsgbot)/ai.mynomos.imsg-mcp
  # as imsgbot:
  /usr/local/libexec/imsg-mcp/imsg-mcp selftest --launchd
  brew pin steipete/tap/imsg
  ```

  `get_status` shows both the running and the installed imsg version, so you can tell when a restart is pending.

- **imsg-mcp:** build, sign with the **same identity**, swap the binary in place, restart:

  ```bash
  scripts/build.sh && scripts/sign.sh "imsg-mcp local signing"
  # (identity from scripts/make-signing-identity.sh? prefix sign.sh with
  #  IMSG_MCP_SIGN_KEYCHAIN=~/Library/Keychains/imsg-mcp-signing.keychain-db)
  sudo scripts/update.sh --user imsgbot
  ```

  `update.sh` refuses a binary whose signing requirement differs from the installed one (macOS would drop the grants) unless you pass `--force`. Same signature means macOS keeps Full Disk Access and Automation.

- **macOS:** apply updates by hand on a day you can check the heartbeat afterwards, then run the selftest.

## Everyday commands

```bash
UID_BOT=$(id -u imsgbot)
sudo launchctl print gui/$UID_BOT/ai.mynomos.imsg-mcp | head -20        # state, pid, last exit
sudo launchctl kickstart -k gui/$UID_BOT/ai.mynomos.imsg-mcp           # restart
sudo launchctl kill SIGHUP gui/$UID_BOT/ai.mynomos.imsg-mcp            # reload config
sudo launchctl bootout gui/$UID_BOT/ai.mynomos.imsg-mcp                # stop (kill switch 3)
curl -s http://127.0.0.1:8788/healthz | jq .
```

## Backups

Nothing here needs backing up except the config and the signing certificate. `state.db` is a cache of the last 14 days of inbound messages and rebuilds itself; the audit log is worth keeping if you want a long history of sends.
