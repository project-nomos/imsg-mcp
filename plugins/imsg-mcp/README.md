# imsg-mcp agent plugin

This plugin connects an AI agent to your [imsg-mcp](../../README.md) server and adds the `imessage` skill. The skill teaches the agent to read, search and catch up on your iMessage and SMS texts, treat message text as untrusted, and show you the exact draft before any send.

The folder is one plugin in two formats that share the skill:

| Format                                          | Files                                                         | Read by                                               |
| ----------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| [Agent Plugins 1.0](https://agent-plugins.org/) | `plugin.json`, `skills/`, and the `mcp.example.json` template | ChatGPT, Codex, Cursor, VS Code, GitHub Copilot, Kiro |
| Claude Code                                     | `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`          | Claude Code                                           |

Every user's server has its own address. Claude Code asks for yours when you enable the plugin. The Agent Plugins format has no way to ask, so its published package carries the skill, and you add the server in your client's MCP settings or in your own copy of the plugin ([below](#bundle-your-server-in-your-own-copy)).

## Before you start

You need a running server. [Remote mode](../../README.md#full-setup-remote-mode-on-a-mac-mini) gives you an address such as `https://imsg.example.com/mcp`, protected by Cloudflare Access. The first time a client connects, it opens the Cloudflare sign-in page; sign in with an email your Access policy allows. Clients that sign in through the web, such as ChatGPT, need their redirect URI allowed first ([docs/cloudflare.md](../../docs/cloudflare.md#redirect-uris-for-other-clients)).

## Claude Code

```text
/plugin install imsg-mcp --marketplace project-nomos/imsg-mcp
```

Claude Code asks for your server URL when you enable the plugin. Then run `/mcp`, choose the `imessage` server and **Authenticate**. On Claude Code older than 2.1.275, add the marketplace first with `/plugin marketplace add project-nomos/imsg-mcp`, then run `/plugin install imsg-mcp@imsg-mcp`.

## Claude on the web, desktop and mobile, and Claude Duet

These use a custom connector for the server, and you can upload the skill to your Claude account; see [docs/clients.md](../../docs/clients.md#the-imessage-skill-on-your-claude-account).

## ChatGPT and Codex

```bash
codex plugin marketplace add project-nomos/imsg-mcp
```

Restart the ChatGPT desktop app and install **imsg-mcp** from its Plugins Directory ([OpenAI docs](https://developers.openai.com/plugins/build/plugins)). In ChatGPT, add the server with **Plugins > + > Add custom MCP server** ([docs/clients.md](../../docs/clients.md#chatgpt-and-dots)).

## GitHub Copilot CLI

```bash
copilot plugin install project-nomos/imsg-mcp:plugins/imsg-mcp
```

([GitHub docs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference))

## VS Code

Turn on the `chat.plugins.enabled` setting, run **Chat: Install Plugin from Source** from the Command Palette, and choose the `plugins/imsg-mcp` folder of a local clone ([VS Code docs](https://code.visualstudio.com/docs/copilot/customization/agent-plugins)).

## Cursor

Copy the folder to `~/.cursor/plugins/local/imsg-mcp` ([Cursor docs](https://cursor.com/docs/plugins)).

## Kiro

Kiro calls plugins Powers: **Powers panel > Add Custom Power** ([Kiro docs](https://kiro.dev/docs/powers/installation/)). Its docs do not cover a plugin in a repository subfolder, so point it at a local copy if the GitHub import does not find the plugin.

## Bundle your server in your own copy

To carry the server inside the plugin instead of adding it in the client's settings, make a copy, turn the template into `mcp.json` and put your address in it:

```bash
git clone https://github.com/project-nomos/imsg-mcp
mkdir -p ~/agent-plugins && cp -R imsg-mcp/plugins/imsg-mcp ~/agent-plugins/
cd ~/agent-plugins/imsg-mcp
sed 's#https://imsg.example.com/mcp#https://imsg.yourdomain.com/mcp#' mcp.example.json > mcp.json
```

Then install `~/agent-plugins/imsg-mcp` from that folder. The client handles sign-in itself: it reads the server's OAuth metadata and opens the Cloudflare page.

For a client on the same Mac as Messages, you can skip Cloudflare: put `imsg-mcp` on your `PATH` (for example `sudo ln -s /usr/local/libexec/imsg-mcp/imsg-mcp /usr/local/bin/imsg-mcp`) and use this server entry in `mcp.json`:

```json
{ "type": "stdio", "command": "imsg-mcp", "args": ["stdio"] }
```

In that local mode, macOS checks Full Disk Access against the client app, which is a broader grant than remote mode; see [docs/clients.md](../../docs/clients.md#local-mode-stdio).

## Sending

`send_message` appears only when sending is on in the server config, and the server enforces the allowlist, length limit and rate limit on every call. Approve each send yourself, and never allow it permanently.
