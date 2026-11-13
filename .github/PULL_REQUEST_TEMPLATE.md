## What and why

<!-- What does this change, and why? Link the issue. -->

## Safety checklist

- [ ] No message text or tokens reach `server.log` (only the audit log records send text).
- [ ] Send rules, the allowlist, rate limit and `send.enabled` cannot be changed by a tool call.
- [ ] Results that carry third-party text are marked `untrusted_content`.
- [ ] `read.scope` is respected by any new read path.
- [ ] Only documented imsg parameters are sent (newer imsg rejects unknown keys).

## Testing

- [ ] `bun run check` passes.
- [ ] Added or updated tests (bug fixes include a test that fails without the fix).
- [ ] Docs and `CHANGELOG.md` updated.
- [ ] If tested against real Messages: how (redact numbers and text).
