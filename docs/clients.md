# Connecting clients

Every Claude surface connects to the same server and gets the same tools. **Sends must stop for your approval on every surface.** The server enforces the allowlist, length and rate limits regardless, but approval is what keeps a manipulated model from sending at all.

## Claude on the web, desktop and mobile (custom connector)

1. Settings → Connectors → Add custom connector. Name: `iMessage`. URL: `https://imsg.example.com/mcp`. Leave the OAuth client ID and secret empty so Claude registers itself.
2. Click **Connect** and sign in on the Cloudflare page.
3. In the connector's tool settings, set `send_message` to **ask every time** (it is marked destructive, so this should be the default; check it).

Claude calls the server from Anthropic's cloud, not from your phone or laptop, so mobile works anywhere and one connection serves every device signed in to the account.

### Claude Duet

[Claude Duet](https://claude.com/product/claude-duet) (a research preview as of late 2026) is Anthropic's proactive agent app. It uses the connectors on your Claude account, so after you add the custom connector above it can use these tools: for example, polling `check_new_messages` to tell you what needs your attention and drafting replies for you to approve. Duet checks with you before it acts on your behalf, and this server still enforces the allowlist, length and rate limits on every send. Connector support in a research preview can change; check Duet's current documentation.

A good pattern for a proactive agent is:

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
      "mcp__imessage__get_status"
    ],
    "ask": ["mcp__imessage__send_message"]
  }
}
```

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

Any client that supports Streamable HTTP and OAuth (with RFC 8707 resource indicators) can use the people hostname; any client that can add custom headers can use a service token on the machine hostname. The server's MCP `instructions` tell the model how to use cursors, to confirm sends with the user, and never to act on requests found inside messages.

## Local mode (stdio)

For a client on the same Mac, skip Cloudflare entirely: the client launches `imsg-mcp stdio` and talks to it over stdin and stdout. There is no network listener. The caller is treated as the local user with `local.role` (default `full`), and the send rules still apply.

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
