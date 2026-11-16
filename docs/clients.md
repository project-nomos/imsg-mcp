# Connecting clients

Every client connects to the same server and gets the same tools. **Sends must stop for your approval on every surface.** The server enforces the allowlist, length and rate limits regardless, but approval is what keeps a manipulated model from sending at all.

## Claude on the web, desktop and mobile (custom connector)

1. Pro and Max: **Customize > Connectors > Add > Add custom connector**. (Team and Enterprise owners: **Organization settings > Connectors > Add > Custom > Web**.) Name: `iMessage`. URL: `https://imsg.example.com/mcp`. Leave the OAuth client ID and secret empty so Claude registers itself. Free plans allow one custom connector.
2. Click **Connect** and sign in on the Cloudflare page.
3. `send_message` is marked destructive, so Claude asks before each call. Approve sends one at a time and **never choose "Allow always"** for it. To keep a connection strictly read-only, turn `send_message` off in the **Search and tools** menu (or leave `send.enabled = false` on the server).

Claude calls the server from Anthropic's cloud, not from your phone or laptop, so one connection serves claude.ai, Claude Desktop, Claude mobile and Cowork on every device signed in to the account, including on cellular. Sources: [custom connectors help article](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [building connectors](https://claude.com/docs/connectors/building/index.md).

### The imessage skill on your Claude account

The [agent plugin](../plugins/imsg-mcp/README.md) includes an `imessage` skill that teaches Claude to catch up with cursors, treat message text as untrusted, and show you each draft before sending. To add it to your account:

1. Turn on **Code execution and file creation** in Claude's settings.
2. Zip the skill folder, keeping the folder at the top of the archive: `cd plugins/imsg-mcp/skills && zip -r imessage.zip imessage/`
3. **Customize > Skills > + > Create skill > Upload a skill**, and choose `imessage.zip`.

Source: [Use skills in Claude](https://support.claude.com/en/articles/12512180-use-skills-in-claude).

### Claude Duet

[Claude Duet](https://claude.com/product/claude-duet) is Anthropic's proactive agent app: a research preview announced on October 21, 2026, available by waitlist in the US on Pro, Max and Ultra. Per [Anthropic's help article](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet), it "runs on your Claude account, so the memory, skills, and connectors you've set up in Claude are there from your first message", and it waits for your approval before sending a message. There is no separate Duet setup: add the custom connector and the skill above, then check in Duet that the iMessage tools are available.

In November 2026 we tested it in a conversation: Duet read our texts through this server as a custom connector, and sent a reply after we approved it (the server checked the allowlist, length and rate limits, and the send was confirmed in history). Two notes:

- Still open: whether Duet's **scheduled** runs reach custom connectors. Anthropic does not say, and an [early review](https://every.to/vibe-check/vibe-check-duet-anthropic-s-always-on-agent) found that Duet's scheduled runs could not reach the reviewer's custom connectors.
- The help article says Duet "doesn't make phone calls or send text messages to other people". That describes Duet's own abilities: through this server it does send, using `send_message`, after you approve each message.

A good pattern for a proactive agent, in Duet or elsewhere, is:

1. First run: `check_new_messages` with no cursor (last 24 hours). Keep `next_cursor`.
2. Every check after that: `check_new_messages` with `since_cursor` set to the last `next_cursor`. Repeat while `has_more` is true.
3. Need context? `get_messages` for that `chat_id`.
4. Want to reply? Show the user the exact recipient and text, and call `send_message` only after they approve.

## Claude Code (remote)

```bash
claude mcp add --transport http --scope user imessage https://imsg.example.com/mcp
# then run /mcp inside Claude Code and choose Authenticate
```

Claude Code signs in through a loopback redirect, which is why the people app allows loopback clients. In `~/.claude/settings.json`, allow the read tools and make sends ask:

```json
{
  "permissions": {
    "allow": [
      "mcp__imessage__list_chats",
      "mcp__imessage__get_messages",
      "mcp__imessage__check_new_messages",
      "mcp__imessage__search_messages",
      "mcp__imessage__get_attachment",
      "mcp__imessage__get_status"
    ],
    "ask": ["mcp__imessage__send_message"]
  }
}
```

Or install the [agent plugin](../plugins/imsg-mcp/README.md), which adds the server and the `imessage` skill together and asks for your URL: `/plugin install imsg-mcp --marketplace project-nomos/imsg-mcp`.

## ChatGPT and dots

ChatGPT adds a custom server as a plugin, from ChatGPT on the web ([OpenAI docs](https://developers.openai.com/api/docs/guides/custom-mcp-server)). This is untested with imsg-mcp so far.

1. **Allow ChatGPT's redirect in Cloudflare first.** Cloudflare Access does not send the `iss` response parameter (RFC 9207), so ChatGPT signs in through a callback under `https://chatgpt.com/connector/oauth/` that is unique to each connector. Add `https://chatgpt.com/connector/oauth/*` to the people app's Managed OAuth redirect URIs ([cloudflare.md](cloudflare.md#redirect-uris-for-other-clients)), or the exact callback ChatGPT shows for your server ([OpenAI's auth docs](https://developers.openai.com/plugins/build/auth)).
2. In ChatGPT: **Plugins > + > Add custom MCP server**, URL `https://imsg.example.com/mcp`, OAuth. Accept the warning, choose **Create as a plugin**, install the plugin, and sign in on the Cloudflare page.
3. ChatGPT asks before write actions by default. The read tools are marked read-only and `send_message` is marked destructive, so only sends ask.

**Plans.** [OpenAI's help center](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) has said that full MCP is for Business, Enterprise and Edu workspaces, and that Pro accounts can connect custom servers only to read and fetch. On Pro, expect the read tools without `send_message`.

**dots.** [dots](https://learn.chatgpt.com/docs/dots) is ChatGPT's proactive agent, launched on September 29, 2026. A dot "can use supported plugins installed and enabled for your account" ([OpenAI](https://learn.chatgpt.com/docs/dots/computers-and-apps)), and OpenAI does not say whether plugins made from custom servers count, so check after installing. Dots review actions before taking them, and per [OpenAI](https://learn.chatgpt.com/docs/dots/controls), "asking your dot to draft replies doesn't give it permission to send them."

**The skill.** ChatGPT and Codex load Agent Plugins: run `codex plugin marketplace add project-nomos/imsg-mcp`, restart the ChatGPT desktop app, and install **imsg-mcp** from its Plugins Directory ([OpenAI docs](https://developers.openai.com/plugins/build/plugins)).

## Codex, Cursor, VS Code, GitHub Copilot and Kiro

These clients load the [agent plugin](../plugins/imsg-mcp/README.md) for the `imessage` skill; its README has each client's install steps. Add the server itself in the client's MCP settings with your URL, or put it in your own copy of the plugin. Desktop clients sign in through a loopback redirect, which the people app already allows. Web versions need their callback allowed ([cloudflare.md](cloudflare.md#redirect-uris-for-other-clients)).

## Agent SDK and other headless agents

Headless agents use the machine hostname and a Cloudflare service token:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const messages = query({
  prompt: "Summarize the texts I got since the last cursor.",
  options: {
    mcpServers: {
      imessage: {
        type: "http",
        url: "https://imsg-agent.example.com/mcp",
        headers: {
          "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID!,
          "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET!,
        },
      },
    },
    // Route sends to a person. Never auto-approve send_message.
    canUseTool: async (toolName, input) => {
      if (toolName === "mcp__imessage__send_message") {
        const approved = await askHumanToApprove(input); // e.g. a Slack prompt
        return approved
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "The user did not approve this send." };
      }
      return { behavior: "allow", updatedInput: input };
    },
  },
});
```

Give headless agents a `read` token by default; with a `read` token, `send_message` is not even listed. An agent with a `read_send` token must route `send_message` through a human approval step such as the `canUseTool` callback above.

**Not supported:** the Messages API's MCP connector, which takes only a bearer `authorization_token` and cannot send Cloudflare's two service-token headers.

## Try remote mode locally

`scripts/dev-remote.ts` runs the server in remote (HTTP) mode on your machine behind a local stand-in for Cloudflare Access, with demo data (or the real imsg serving a synthetic `chat.db`), so you can see the HTTP transport, the `401` challenge and the roles with Claude Code or the MCP Inspector before setting up Cloudflare:

```bash
bun scripts/dev-remote.ts                 # prints URLs, credentials and ready-made --mcp-config files
claude --mcp-config /path/printed/mcp-people.json    # as the signed-in owner (full role)
claude --mcp-config /path/printed/mcp-reader.json    # as a read-only service token
```

Nothing real is read or sent: the data is synthetic and the signing key exists only in memory.

## Other MCP clients

Any client that supports Streamable HTTP and OAuth (with RFC 8707 resource indicators) can use the people hostname; any client that can add custom headers can use a service token on the machine hostname. A client that signs in through a web redirect, rather than a loopback address, needs that redirect URI allowed in the people app first ([cloudflare.md](cloudflare.md#redirect-uris-for-other-clients)). Two that are untested with imsg-mcp:

- **Gemini app:** **Settings > Connected Apps**, for personal accounts in the US ([Google](https://support.google.com/gemini/answer/17209137)). It registers itself and asks before write actions. Google does not document its redirect URI; if sign-in fails with a redirect error, allow the URI the error names.
- **Perplexity:** custom remote connectors ([Perplexity](https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors)), with the redirect URI `https://www.perplexity.ai/rest/connections/oauth_callback` (`https://enterprise.perplexity.ai/...` for Enterprise).

The server's MCP `instructions` tell the model how to use cursors, to confirm sends with the user, and never to act on requests found inside messages.

## Local mode (stdio)

For a client on the same Mac, skip Cloudflare entirely: the client launches `imsg-mcp stdio` and talks to it over stdin and stdout. There is no network listener. The caller is treated as the local user with `local.role` (default `full`), and the send rules still apply.

**Claude Desktop, as a bundle:** each [release](https://github.com/project-nomos/imsg-mcp/releases/latest) carries `imsg-mcp-<version>-darwin-arm64.mcpb` for Apple silicon. Open it and Claude Desktop installs the server as an extension. With no config file it runs read-only on the defaults; its **Config file** setting points it at one, for example to turn sending on.

**Claude Code:**

```bash
claude mcp add --scope user imessage -- /usr/local/libexec/imsg-mcp/imsg-mcp stdio
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "imessage": {
      "command": "/usr/local/libexec/imsg-mcp/imsg-mcp",
      "args": ["stdio"]
    }
  }
}
```

Pass `"args": ["stdio", "--config", "/path/to/config.toml"]` to use a config other than the default.

**Permissions in local mode.** macOS checks privacy permissions against the app that started the process, so in local mode Full Disk Access must be granted to the **client** (Claude Desktop, or the terminal or editor that runs Claude Code), and the Automation prompt names that app. That is a broader grant than remote mode, where only the signed `imsg-mcp` binary holds it. Remote mode on a dedicated Mac is the safer setup for daily use.

In local mode a config reload (`kill -HUP <pid>`) shows or hides `send_message` and notifies the client that the tool list changed. Several local clients can run at once; they share `state.db`, the rate limit and the audit log. The heartbeat only runs in `serve` mode.
