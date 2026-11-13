# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this is

`imsg-mcp` is an MCP server that lets AI assistants read and send iMessage/SMS through a Mac. It wraps [`imsg`](https://github.com/steipete/imsg) (`imsg rpc`, JSON-RPC over stdio) and adds MCP tools, Cloudflare Access JWT authentication, send guardrails, an inbound message store, an audit log and unattended-operation plumbing. TypeScript on Bun; shipped as one binary via `bun build --compile`.

## Commands

```bash
bun install
bun test                      # unit + integration (stub imsg, no macOS permissions needed)
bun test test/unit/config.test.ts
bun run typecheck             # tsc --noEmit
bun run lint                  # eslint
bun run format                # prettier --write
bun run check                 # everything CI runs
scripts/build.sh              # dist/imsg-mcp
bun run src/cli.ts --help
```

## Layout

- `src/cli.ts`: commands (`serve`, `stdio`, `selftest`, `check-config`, `init`, `version`) and signal handling.
- `src/app.ts`: wires everything; `App.create` checks `imsg status --json` for required RPC methods.
- `src/http/mcp-http.ts`: `/mcp` handler (JWT check, then a fresh stateless MCP server per request). `src/http/health-http.ts`: `/healthz`.
- `src/auth/access.ts`: Cloudflare Access JWT verification and identity to role mapping.
- `src/imsg/`: the child-process JSON-RPC client, error classification, status probe, raw payload types.
- `src/core/`: `imsg-api.ts` (the only place that builds imsg params), `watcher.ts` (watch stream, cursor, backfill, sync check), `chats.ts`, `format.ts` (output shape, truncation, `untrusted`), `scope.ts`, `handles.ts`.
- `src/send/`: `rules.ts` (rules 1 to 3), `rate-limiter.ts` (rule 4), `service.ts` (pipeline, audit, confirmation, retry).
- `src/tools/`: tool registration; every tool body runs through `runTool` for auditing and error mapping.
- `src/store/state-db.ts`: SQLite (`bun:sqlite`): inbound store, cursor, send times.
- `test/fixtures/stub-imsg.ts`: fake `imsg` used by integration tests. `test/helpers/harness.ts`: spins up an App against it.

## Invariants (do not break)

- Never log message text or tokens. Only the audit log records send text.
- `send_message` is registered only when `send.enabled` is true and the role can send; the service re-checks every rule on each call in the spec's order (role, allowlist, length, rate).
- The server trusts only a verified `Cf-Access-Jwt-Assertion` in HTTP mode. Listeners are loopback-only (config validation enforces it).
- Results with third-party text carry `untrusted_content: true` and the standard note.
- Send only documented params to imsg (0.14+ rejects unknown keys). Keep 0.8.2 working.
- The watch cursor only moves forward; storing a row and moving the cursor happen in one transaction.
- No em dashes in docs or user-facing text (project style).

## Testing notes

- Integration tests talk to the server over real HTTP (with RS256 test keys from `accessKeys()`) or real stdio, never by calling tool functions directly.
- Use stub behaviours (`h.setBehavior({...})`) and `h.inject({...})` to simulate Messages events; use `waitFor` rather than fixed sleeps.
- Tests must not touch the real Messages database or send real texts.
- `test/integration/real-imsg.test.ts` (opt-in: `IMSG_MCP_TEST_REAL_IMSG=1`) drives the real imsg binary with a synthetic chat.db under `sandbox-exec` so no Contacts prompt can appear; keep sending disabled there.
