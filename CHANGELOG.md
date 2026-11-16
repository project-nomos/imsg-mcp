# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `scripts/make-signing-identity.sh`: a self-signed code-signing identity in its own keychain, so builds can be signed over SSH; `scripts/sign.sh` uses it through `IMSG_MCP_SIGN_KEYCHAIN`.
- `deploy/launchd/ai.mynomos.imsg-tunnel.plist` and docs for a locally managed tunnel that runs as your user, with no root.
- Docs for running the service as your own user, and for a Mac where `imsg` already comes from another Homebrew package.
- Docs: why remote mode uses Cloudflare Access and which alternatives were considered (architecture.md), a README FAQ on costs, what each response code from the hostname means, and the security cost of running as your own user.
- Agent plugin in `plugins/imsg-mcp` with an `imessage` skill (finding chats, catching up with cursors, treating message text as untrusted, showing the exact draft before any send). It is packaged as an [Agent Plugins 1.0](https://agent-plugins.org/) package for ChatGPT, Codex, Cursor, VS Code, GitHub Copilot and Kiro, with an `mcp.example.json` template for your server, and as a Claude Code plugin with a marketplace in `.claude-plugin/` that includes the server and asks for its URL. Tests validate it against the official Agent Plugins schemas.
- Docs: a "Works with" table in the README with an honest status per assistant; setup for ChatGPT and dots, Codex, Cursor, VS Code, GitHub Copilot, Kiro, Gemini and Perplexity; uploading the skill to a Claude account; the redirect URIs each web client needs in Cloudflare Access; a note that the project is independent of the companies whose products it works with.
- `docs/privacy.md`: what the server reads, what it keeps and for how long, and where data goes.
- Automatic releases: every merge to `main` that adds entries under Unreleased in this changelog is released. The entries pick the version (a minor release for Added, Changed, Deprecated or Removed; a patch for only Fixed or Security). The Release workflow builds the binaries and an MCP Bundle, pushes the release commit and tag, publishes the GitHub release with the changelog notes, and lists the release in the official MCP Registry as `io.github.project-nomos/imsg-mcp`. Run it by hand with **dry run** to build and validate without publishing, or with a version for a major release.
- MCP Bundle (`.mcpb`, Apple silicon) on each release: a one-file install of local mode in Claude Desktop.
- `deploy/demo/Dockerfile`: a demo image for MCP directories that start a server to check its tools. It runs stdio mode against the test stand-in for imsg with sample conversations. Also `glama.json`, which names the maintainer for Glama.
- Local stdio mode starts read-only on the defaults when there is no config file, so a client or the bundle can run it before `imsg-mcp init`. An invalid file still stops it.
- Attachments: every attachment in a message now has an `id`, and the new `get_attachment` tool opens it. Photos come back as images (HEIC, TIFF and large photos converted to JPEG and scaled to `attachments.max_image_px`), PDFs as their text and page images (`pages` picks which), videos as four still frames and their length, audio as its length, and Word, RTF, HTML, contact cards, calendar invites and other text files as text. Conversion uses macOS's own tools (`sips`, `textutil`, PDFKit, AVFoundation), each run in a sandbox with no access to the home folder, no network of its own, no Apple Events and no other programs, with remote content loading turned off; their output is read back only under fixed names, never through links. Files are opened only from inside the Messages attachments folder, and results are flagged `untrusted_content`. New `[attachments]` settings: `enabled` (default true), `max_file_mb` (200) and `max_image_px` (1568).
- Sending files: with `send.files = true`, `send_message` can forward an attachment (`attachment_id`) or send a new file the assistant writes (`file`, with its content as text or base64, up to 5 MB), with or without text. Programs, scripts, installers, archives and macro-capable old Office files are refused; `send.max_file_mb` (default 100) caps the size. The allowlist, approval and rate limit apply as for text, and the audit log records each file's name, size and SHA-256.

### Security

- Dev dependencies: eslint 10.15.0, and an override that forces minimatch 11 for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (lint tooling only; not part of the server binary). `bun audit` reports no vulnerabilities. Runtime dependencies, Bun 1.4.4 and imsg 0.21.0 were already current. TypeScript stays on 6.x until typescript-eslint supports 7.

### Changed

- Local (stdio) mode no longer opens Messages.app when a client starts it; a send still opens Messages if it is closed. Serve mode keeps relaunching it (`health.relaunch_messages`).
- Message text no longer includes the placeholder character Messages stores for an attachment, so a message that is only a photo has empty text.
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
[0.1.0]: https://github.com/project-nomos/imsg-mcp/tree/90b55bf638f4d7336ffef3f00a1087a26cc07bb1
