# Contributing to imsg-mcp

Thanks for helping. This project touches people's private messages and can send texts in their name, so changes are held to a high bar for safety and clarity.

## Development setup

You need macOS (for the real thing) and [Bun](https://bun.sh) 1.2 or later (`bun upgrade`). The test suite runs anywhere Bun runs, including Linux, because it uses a stub `imsg`.

```bash
git clone https://github.com/project-nomos/imsg-mcp.git
cd imsg-mcp
bun install
bun run check        # typecheck + lint + format check + tests
```

Useful commands:

```bash
bun test                       # all tests
bun test test/unit             # unit tests only
bun test --watch               # rerun on change
bun run format                 # prettier --write
scripts/build.sh               # single binary in dist/
bun run src/cli.ts stdio --config ./dev-config.toml   # run locally against real imsg
bun scripts/dev-remote.ts      # remote (HTTP) mode behind a local Access stand-in
```

Running against your real Messages needs Full Disk Access for your terminal (local development only; see [docs/clients.md](docs/clients.md#local-mode-stdio)). Keep `send.enabled = false` unless you are testing sends, and allowlist only your own number.

## Making changes

1. Open an issue first for anything beyond a small fix, especially changes to authentication, the send rules, or what data leaves the Mac.
2. Branch from `main`.
3. Add or update tests. Bug fixes need a test that fails without the fix. The stub imsg (`test/fixtures/stub-imsg.ts`) can simulate most situations; extend it rather than mocking internals.
4. Update the docs in `docs/` and the `CHANGELOG.md` "Unreleased" section.
5. `bun run check` must pass.
6. Open a pull request using the template.

## Ground rules for the code

- **Never log message text or tokens.** `server.log` is operational; only the audit log records send text, by design.
- **Send rules stay outside the model's reach.** Anything that lets a tool call change the allowlist, the rate limit or `send.enabled` will not be accepted.
- **Fail closed.** Unknown config keys, unparseable handles and unknown chats are errors, not silent passes.
- **Talk to imsg only through `src/core/imsg-api.ts`**, and send only documented parameters: newer imsg versions reject unknown keys.
- **Errors are for the model and the user.** Tool errors should say what went wrong and what to do.
- TypeScript strict mode, ES modules, Prettier formatting (double quotes, trailing commas, 100 columns). Write no `console.*` in `src/`; use the logger (stdout is the MCP transport in stdio mode).

## Adding a tool

1. Register it in `src/tools/read-tools.ts` (or a new file) with a Zod input schema, a clear description, and accurate annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint`).
2. Wrap the body in `runTool(...)` so it is audited (chat ids and counts, never text).
3. Respect `read.scope` and mark results that carry third-party text with `untrusted(...)`.
4. Add integration tests over HTTP (see `test/integration/server.test.ts`) and document it in `docs/tools.md` and the README tool table.

## Testing against the real imsg

Changes to the imsg bridge, the watcher or payload mapping should also pass against the real binary (macOS with imsg installed; no permissions needed, nothing is sent):

```bash
IMSG_MCP_TEST_REAL_IMSG=1 bun test test/integration/real-imsg.test.ts
```

## Supporting a new imsg version

Check its `docs/rpc.md` and payload builders, add any new behaviour to the stub (gated on `STUB_IMSG_VERSION`), and run the suite against both the oldest supported version (0.8.2) and the new one.

## Reporting issues

Use the issue templates. Include your macOS version, `imsg --version`, `imsg-mcp version`, the output of `imsg-mcp check-config`, and relevant `server.log` lines. **Remove phone numbers, emails and message text** before posting.

Security problems: see [SECURITY.md](SECURITY.md). Please do not report them in public issues.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
