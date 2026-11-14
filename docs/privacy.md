# Privacy

imsg-mcp is software you run on your own Mac. The project's maintainers run no service for it, receive none of your data, and the software contains no analytics or telemetry. This page describes where your messages go when you use it.

## What it reads

When an AI client calls one of its tools, the server reads the Messages database on the Mac (`~/Library/Messages/chat.db`) through `imsg`. It also watches for new messages as they arrive, so it can answer "what's new" questions. `read.scope` can limit it to chosen chats.

## What it keeps on the Mac

| File          | What it holds                                                                                                                           | Kept for (default)                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `state.db`    | Messages received through the watch (to serve `check_new_messages`), the watch position, and send times for the rate limit              | 14 days (`store.retention_days`)          |
| `server.log`  | Operational events. Never message text.                                                                                                 | 14 days (`logging.server_retention_days`) |
| `audit.jsonl` | One record per tool call: who called, which tool, chat ids and row counts. For sends, also the recipient and the full text you approved | 90 days (`logging.audit_retention_days`)  |

Paths are in [configuration.md](configuration.md). Deleting these files removes everything imsg-mcp has stored; your Messages history itself is untouched.

## Where data goes

- **To the AI client that calls a tool.** Tool results, including message text, go to that client and to the company that runs it. A Claude custom connector, for example, calls the server from Anthropic's cloud. That provider's privacy terms cover what the assistant reads.
- **Through Cloudflare, in remote mode.** Requests and responses pass through Cloudflare Tunnel and Access, which end TLS at Cloudflare's edge, so Cloudflare handles the traffic in transit under its own privacy policy. Local mode (`imsg-mcp stdio`) uses no network at all.
- **When you approve a send.** Messages on your Mac sends the text through Apple's iMessage service or your carrier (SMS), as if you had typed it.

The server itself makes only two kinds of outbound requests: it fetches your Cloudflare Access team's public keys to verify sign-ins, and, if you set `heartbeat.url`, it pings that URL on a schedule with no message content.

## What you control

- Sending is off until you turn it on, and then reaches only the recipients on your allowlist ([configuration.md](configuration.md)).
- `read.scope` limits which chats can be read at all.
- The retention settings above, and the kill switches in [security.md](security.md#kill-switches), stop or erase access at any time.

## Questions

Open an issue on [GitHub](https://github.com/project-nomos/imsg-mcp/issues). Report security problems privately as described in [SECURITY.md](../SECURITY.md).
