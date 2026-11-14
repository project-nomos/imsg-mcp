# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `scripts/make-signing-identity.sh`: a self-signed code-signing identity in its own keychain, so builds can be signed over SSH; `scripts/sign.sh` uses it through `IMSG_MCP_SIGN_KEYCHAIN`.
- `deploy/launchd/ai.mynomos.imsg-tunnel.plist` and docs for a locally managed tunnel that runs as your user, with no root.
- Docs for running the service as your own user, and for a Mac where `imsg` already comes from another Homebrew package.
- Docs: why remote mode uses Cloudflare Access and which alternatives were considered (architecture.md), a README FAQ on costs, what each response code from the hostname means, and the security cost of running as your own user.

### Changed

- Docs: the tunnel is now created with `cloudflared` commands and run as a LaunchAgent of the service user, started only once Access protects the hostnames. A dashboard tunnel with a root LaunchDaemon is the alternative. The machines Access application is marked optional.

## [0.1.0] - 2026-11-13

First release.

### Added

- MCP server over Streamable HTTP (stateless, JSON responses) on loopback, for use behind Cloudflare Tunnel and Access.
- Cloudflare Access JWT verification on every request (RS256 against the team JWKS; `aud`, `iss`, `exp`, `nbf`), with people (`full` role) and service tokens (`read` or `read_send`).
- Local mode: `imsg-mcp stdio` for Claude Desktop and Claude Code on the same Mac.
- Tools: `list_chats`, `get_messages`, `check_new_messages`, `search_messages`, `get_status`, `send_message`.
- Bridge to one long-lived `imsg rpc` child: 10 s call timeouts, restart with backoff, startup check of required RPC methods, support for imsg 0.8.2 through 0.21 (strict params, `messages.search`, `chats.get`, `watch.overflow`).
- Inbound store in SQLite with a persisted watch cursor, 24-hour backfill on first start, sync check and resubscribe, 14-day retention.
- Send guardrails: off by default, allowlist (every group member, or the chat id), length limit, persisted sliding-window rate limit, history confirmation, before and after audit records, one retry when Messages.app was not running.
- `untrusted_content` flag and note on every result that carries third-party text; read scope by chat id, chat GUID or handle.
- Operations: `/healthz` on a separate loopback port, Messages.app relaunch, heartbeat for a dead-man's switch, daily-rotated `server.log` (14 days) and `audit.jsonl` (90 days), config reload on `SIGHUP`.
- `imsg-mcp selftest` (with `--launchd` to test the service's own macOS permissions), `check-config` and `init`.
- `imsg-mcp acceptance`: the automatable acceptance checks against a deployment (401 at Cloudflare, 403 at the origin, health, read-token tool list, latency, allowlist refusal).
- Tests against the real `imsg` binary with a synthetic `chat.db` (opt-in locally, in CI on macOS), and an end-to-end test through a Cloudflare Access emulator.
- `scripts/dev-remote.ts`: remote mode on your own machine behind a local Access stand-in, for trying the HTTP transport with Claude Code or the MCP Inspector.
- `read.max_result_chars` (default 60,000): results are trimmed to stay under Claude's tool result limits, with cursors that continue where a page stops.
- Build, sign, install, update and uninstall scripts; LaunchAgent template; hardened-runtime entitlements.
- Documentation for architecture, Mac setup, Cloudflare, clients, configuration, tools, security, operations, testing and troubleshooting.

[Unreleased]: https://github.com/project-nomos/imsg-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/project-nomos/imsg-mcp/releases/tag/v0.1.0
