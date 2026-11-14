# imsg-mcp documentation

Start with the [project README](../README.md) for what this is and a quick start.

## Setting it up

1. [Mac mini setup](mac-mini-setup.md): the bot user (or your own), Messages, power, signing, install, macOS permissions, smoke test.
2. [Cloudflare Tunnel and Access](cloudflare.md): the tunnel (a few `cloudflared` commands), the people app (Managed OAuth), the optional machine app (service tokens), and what each response code means.
3. [Connecting clients](clients.md): Claude web, desktop and mobile, Claude Duet, Claude Code, the Agent SDK, and local stdio mode.
4. [Configuration](configuration.md): every config key, roles, reloads.

## Using it

- [Tool reference](tools.md): inputs, outputs, cursors, errors.

## Running it

- [Security and guardrails](security.md): threat model, prompt injection, audit log, kill switches.
- [Operations](operations.md): health, heartbeat, logs, failure modes, updates.
- [Troubleshooting](troubleshooting.md)
- [Testing and acceptance](testing.md): test layers, the selftest, the acceptance checklist.

## Design

- [Architecture](architecture.md): request path, why Cloudflare Access (and the alternatives), the imsg bridge, the inbound store and cursors, sending, open decisions, milestones.
