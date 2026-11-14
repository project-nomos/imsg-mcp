# imsg-mcp agent plugin

This plugin gives an AI agent two things: the connection to your [imsg-mcp](../../README.md) server, and the `imessage` skill, which teaches the agent to read, search and catch up on your iMessage and SMS texts, treat message text as untrusted, and show you the exact draft before any send.

The folder is one plugin in two formats:

| Format                                          | Files                                                | Read by                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Agent Plugins 1.0](https://agent-plugins.org/) | `plugin.json`, `mcp.json`, `skills/`                 | Clients that support the standard, such as Codex, Cursor, VS Code, GitHub Copilot and Kiro |
| Claude Code                                     | `.claude-plugin/plugin.json`, `.mcp.json`, `skills/` | Claude Code                                                                                |

Both share the same skill. Claude on the web, desktop and mobile, and Claude Duet, connect through a custom connector instead; see [docs/clients.md](../../docs/clients.md).

## Before you start

You need a running server. [Remote mode](../../README.md#full-setup-remote-mode-on-a-mac-mini) gives you an address such as `https://imsg.example.com/mcp`, protected by Cloudflare Access. The first time a client connects, it opens the Cloudflare sign-in page; sign in with an email your Access policy allows.

## Claude Code

```text
/plugin install imsg-mcp --marketplace project-nomos/imsg-mcp
```

Claude Code asks for your server URL when you enable the plugin. Then run `/mcp`, choose the `imessage` server and **Authenticate**. Claude Code signs in through a loopback redirect, which works once the Access application's Managed OAuth allows localhost and loopback clients ([docs/cloudflare.md](../../docs/cloudflare.md)).

On Claude Code older than 2.1.275, add the marketplace first: `/plugin marketplace add project-nomos/imsg-mcp`, then `/plugin install imsg-mcp@imsg-mcp`.

## Clients that read Agent Plugins

The portable format has no way to ask for your URL, so install your own copy with your address in `mcp.json`:

```bash
git clone https://github.com/project-nomos/imsg-mcp
mkdir -p ~/agent-plugins && cp -R imsg-mcp/plugins/imsg-mcp ~/agent-plugins/
sed -i.bak 's#https://imsg.example.com/mcp#https://imsg.yourdomain.com/mcp#' ~/agent-plugins/imsg-mcp/mcp.json
```

Then install `~/agent-plugins/imsg-mcp` with your client's plugin command or settings. The client handles sign-in itself: it reads the server's OAuth metadata and opens the Cloudflare page. If the client signs in through a web redirect rather than a loopback address, add that redirect URI to the Access application's Managed OAuth settings ([docs/cloudflare.md](../../docs/cloudflare.md)).

## Local mode, on the Mac itself

For a client on the same Mac as Messages, you can skip Cloudflare: put `imsg-mcp` on your `PATH` (for example `sudo ln -s /usr/local/libexec/imsg-mcp/imsg-mcp /usr/local/bin/imsg-mcp`) and replace the server entry in `mcp.json` with:

```json
{ "type": "stdio", "command": "imsg-mcp", "args": ["stdio"] }
```

In local mode macOS checks Full Disk Access against the client app, which is a broader grant than remote mode; see [docs/clients.md](../../docs/clients.md#local-mode-stdio).

## Sending

`send_message` appears only when sending is on in the server config, and the server still enforces the allowlist, length limit and rate limit on every call. Approve each send yourself; never allow it permanently.
