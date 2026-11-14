# Cloudflare Tunnel and Access

In remote mode, an outbound Cloudflare Tunnel publishes the server, and Cloudflare Access sits in front of it. No request reaches the Mac without a valid sign-in, and the Mac accepts no inbound connections.

There are two parts:

1. **The tunnel:** a few `cloudflared` commands on the Mac. It works on any Cloudflare plan, free included.
2. **Access:** the sign-in in front of the tunnel, set up in the Zero Trust dashboard. Claude signs in through it (Managed OAuth), and the server accepts only requests that Access has signed.

The hostnames must be on a zone in the **same Cloudflare account** as your Zero Trust organization (a Managed OAuth requirement). The examples use `imsg.example.com` for people and `imsg-agent.example.com` for machines. You need the second one only if you run headless agents.

Access needs a Zero Trust organization. The first time you open the Zero Trust dashboard, it asks for a team name, which becomes your team domain (`<name>.cloudflareaccess.com`, used in `access.team_domain`), and a plan. The Free plan covers up to 50 users but still asks for a payment method.

The order below keeps the hostnames unreachable until Access protects them: create the tunnel, add Access, then start the tunnel.

## 1. Create the tunnel

On the Mac, as the user that runs the server:

```bash
cloudflared tunnel login        # prints a link: open it, pick your zone, click Authorize
cloudflared tunnel create mac-mini
cloudflared tunnel route dns mac-mini imsg.example.com
cloudflared tunnel route dns mac-mini imsg-agent.example.com   # only for headless agents
```

- `tunnel login` waits a few minutes for you to authorize, then saves `~/.cloudflared/cert.pem`. If it times out, run it again.
- `tunnel create` prints the tunnel id and writes the tunnel's credentials to `~/.cloudflared/<tunnel-id>.json`.
- `route dns` points each hostname at the tunnel with a DNS record.

Copy [`deploy/cloudflared/config.example.yml`](../deploy/cloudflared/config.example.yml) to `~/.cloudflared/imsg-mcp.yml`, fill in the tunnel id and credentials path, and check it:

```bash
cloudflared tunnel --config ~/.cloudflared/imsg-mcp.yml ingress validate
cloudflared tunnel --config ~/.cloudflared/imsg-mcp.yml ingress rule https://imsg.example.com/mcp
```

Both hostnames go to `http://127.0.0.1:8787`, and everything else gets `404`. Use `127.0.0.1` rather than `localhost`: the server listens on IPv4 loopback only. Never publish the health port (8788). No router port forwarding and no inbound firewall rule are needed.

Keep a hostname's rule in the file only while an Access application protects it. If you skip the machines application, delete the `imsg-agent` rule: its DNS record then falls through to the `404` rule instead of reaching the Mac.

**Don't start the tunnel yet.** Until it runs, the hostnames answer `530`. You start it in [step 4](#4-start-the-tunnel), once Access is in front.

### Alternative: a tunnel managed from the dashboard

You can create the tunnel in Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared instead. There you add both public hostnames, pointing at `http://127.0.0.1:8787`, with the catch-all left at `http_status:404`. Then install it on the Mac with `sudo cloudflared service install <token>`, which runs `cloudflared` as a root LaunchDaemon. With Homebrew, prefer the CLI tunnel above: a root daemon runs a `cloudflared` binary your own user can overwrite, so anything running as that user could gain root.

## 2. Access application for people (Managed OAuth)

This is the only application Claude needs. It covers:

- Claude on the web, desktop and mobile;
- other Claude apps that use your account's connectors, possibly including Claude Duet (see [clients.md](clients.md#claude-duet));
- Claude Code.

In the Cloudflare One dashboard (as of November 2026):

1. **Access controls → Applications → Create new application → Self-hosted and private**, with **Public DNS** selected, then **Continue**.
2. **Destinations:** subdomain `imsg`, domain `example.com`, no path. Protecting the whole hostname also covers the OAuth discovery paths.
3. **Access policies → Create new policy:**
   - Action: **Allow**.
   - Include: **Emails**, listing your addresses (the ones you sign in with) and nobody else.
4. **Authentication:** leave **Accept all available identity providers** on. A new organization signs you in with a one-time PIN: a code sent to your email. If you want MFA, add an identity provider with MFA (for example Google) under **Integrations → Identity providers**.
5. **Additional settings** tab → turn on **Managed OAuth** and expand it:
   - **Allow localhost clients** and **Allow loopback clients**: on (the default). Claude Code signs in through a loopback redirect on a random port.
   - **Allowed redirect URIs**: `https://claude.ai/api/mcp/auth_callback`, the callback of Claude on the web, desktop and mobile.
   - **Grant session duration**: 2 weeks. **Access token lifetime**: leave the default, 15 minutes.

   Dynamic client registration has no switch of its own: Managed OAuth always offers it, restricted to the redirect URIs above and to localhost and loopback clients.

6. **Create**, then open the application again: **Additional settings → Application Audience (AUD) Tag**. Copy it into `access.aud`.

With Managed OAuth on, Access answers unauthenticated requests with `401`, even before the tunnel runs. The `WWW-Authenticate` header points at protected-resource metadata, which also tells you your team domain:

```bash
curl -s https://imsg.example.com/.well-known/oauth-protected-resource/mcp   # "team_domain": "<name>.cloudflareaccess.com"
```

Without Managed OAuth, you get a browser redirect, which agents cannot follow. Cloudflare requires clients that support RFC 8707 resource indicators, so confirm sign-in works from each Claude surface during rollout.

**What about MCP Portals?** Cloudflare One also has **Access controls → MCP Portals**. Its **MCP servers** tab registers a server so that Cloudflare connects to it as a client and offers its tools through a portal URL. It does not protect the server's own hostname. `imsg-mcp` accepts only requests signed by the Access application above, so start with that application. A portal would add a second hop and a second sign-in, and the server would see the portal's credentials instead of you.

## 3. Access application for machines (service tokens, optional)

Skip this if you only use Claude's apps. You need it for:

- Agent SDK agents and other headless clients that cannot do an interactive sign-in;
- the service-token checks in `imsg-mcp acceptance`.

1. **Access controls → Service credentials → Service tokens → Create.**
   - Make one token per agent.
   - Note its **Client ID** (it looks like `0123456789abcdef.access`) and its **Client Secret**. The secret is shown only once.
2. Create a second application the same way as in step 2, for `imsg-agent.example.com`.
3. Policy: action **Service Auth**, include **Service Token**: the tokens you created.
4. Copy this application's AUD tag into `access.aud` as well.
5. Add the `imsg-agent` rule to the tunnel config if you removed it, and restart the tunnel.
6. Map each token to a role in the config. Give agents `read` unless they truly need to send:

   ```toml
   [access.service_tokens]
   "0123456789abcdef.access" = "read"
   "fedcba9876543210.access" = "read_send"
   ```

Clients send the token as two headers, `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Cloudflare checks them and forwards a JWT whose `common_name` claim is the client id. Store secrets in environment variables or a secrets manager, never in code. Tokens are renewed yearly; rotate or revoke them in the dashboard.

**Why two hostnames?** Cloudflare's docs do not say whether Managed OAuth and Service Auth can share one application. Separate applications also let machines get a narrower role.

|                | People (OAuth)                             | Machines (service token)                                    |
| -------------- | ------------------------------------------ | ----------------------------------------------------------- |
| Hostname       | `imsg.example.com`                         | `imsg-agent.example.com`                                    |
| Used by        | Claude web, desktop, mobile; Claude Code   | Agent SDK and other headless agents                         |
| Policy         | Allow, include your email                  | Service Auth, include named service tokens                  |
| Sign-in        | Managed OAuth through an identity provider | `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers |
| Token lifetime | Access token 15 min; grant session 14 days | Service token renewed yearly                                |
| Server role    | `full` (read, plus send if enabled)        | Per token: `read` or `read_send`                            |

## 4. Start the tunnel

Once Access protects the hostnames, run the tunnel as a LaunchAgent of the same user:

1. Replace `__HOME__` in [`deploy/launchd/ai.mynomos.imsg-tunnel.plist`](../deploy/launchd/ai.mynomos.imsg-tunnel.plist).
2. Save it as `~/Library/LaunchAgents/ai.mynomos.imsg-tunnel.plist`.
3. Load it:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.mynomos.imsg-tunnel.plist
   ```

This works over SSH too. It restarts if it exits, and it logs to `~/Library/Logs/imsg-mcp/cloudflared.log`. Updates come through Homebrew (the plist turns off `cloudflared`'s own updater). After `brew upgrade cloudflared`, restart it with `launchctl kickstart -k gui/$(id -u)/ai.mynomos.imsg-tunnel`.

Anything in `~/Library/LaunchAgents` also starts at your next login. If you save the file there before Access is ready:

- run `launchctl disable gui/$(id -u)/ai.mynomos.imsg-tunnel` first (it stays disabled across reboots);
- run `launchctl enable gui/$(id -u)/ai.mynomos.imsg-tunnel` when you load it.

## 5. Server config

```toml
[access]
team_domain = "yourteam.cloudflareaccess.com"   # the team name you chose for Zero Trust
aud = ["<AUD tag of the people app>", "<AUD tag of the machine app, if any>"]
people = ["you@example.com", "you@personal.example"]   # the same addresses the Access policy allows

[access.service_tokens]   # only with the machines application
"0123456789abcdef.access" = "read"
```

Both checks apply: the Access policy decides who can sign in at Cloudflare, and `access.people` decides whom the server serves. To add someone, add them to both.

Reload the config or restart the service:

- **Reload, as the user that runs the server:** `launchctl kill SIGHUP gui/$(id -u)/ai.mynomos.imsg-mcp`.
- **Reload, for a separate bot user:** `sudo launchctl kill SIGHUP gui/$(id -u imsgbot)/ai.mynomos.imsg-mcp`.
- **Restart:** use `launchctl kickstart -k` with the same target.

### Optional: limit the people app to Anthropic's network

Claude on the web, desktop and mobile (and apps that use your account's connectors) call the server from Anthropic's cloud, from `160.79.104.0/21` ([Anthropic IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)). Claude Code calls from your own machine. If you only use the hosted apps, a Cloudflare WAF rule that blocks other sources for `imsg.example.com` adds a layer in front of Access.

## What the origin trusts

Access tokens are opaque to clients. Cloudflare checks each one and sends the origin a signed `Cf-Access-Jwt-Assertion` header, which `imsg-mcp` validates on every request:

- the RS256 signature against `https://<team_domain>/cdn-cgi/access/certs` (keys cached and re-fetched on rotation);
- `iss` equal to `https://<team_domain>`;
- `aud` one of `access.aud`;
- `exp` and `nbf` within `access.clock_tolerance_seconds`.

A missing or invalid token gets `403`. The server trusts nothing else: not the source IP, not the `Host` header, not `Cf-Access-Authenticated-User-Email` or any other forwarded header.

## Verify

What `https://imsg.example.com/mcp` answers tells you which layer replied:

| Answer                        | Meaning                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `530`                         | The tunnel is not connected: not started yet, or `cloudflared` stopped                                                                                                                 |
| `502`                         | The tunnel is up, but nothing answers on `127.0.0.1:8787`: the server is not running                                                                                                   |
| `302` to a login page         | Access is in front, but Managed OAuth is off on the application                                                                                                                        |
| `401` with `WWW-Authenticate` | Correct: Access with Managed OAuth                                                                                                                                                     |
| `403` from the origin         | The request reached the server without a valid Access JWT: no Access application covers the hostname, or `access.aud` / `access.team_domain` do not match it (`server.log` says which) |

```bash
# From anywhere: Access must answer, not the Mac.
curl -si https://imsg.example.com/mcp | head -5           # 401 with WWW-Authenticate

# On the Mac: the origin itself refuses requests without a valid JWT.
curl -si -X POST http://127.0.0.1:8787/mcp | head -1      # HTTP/1.1 403 Forbidden

# A service token end to end (expects a JSON-RPC response):
curl -s https://imsg-agent.example.com/mcp \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Or run the automated checks (see [testing.md](testing.md#acceptance-checklist)). Leave out `--agent-url` and the token variables if you skipped the machines application:

```bash
IMSG_ACCEPTANCE_READ_ID=... IMSG_ACCEPTANCE_READ_SECRET=... \
  imsg-mcp acceptance --public-url https://imsg.example.com/mcp --agent-url https://imsg-agent.example.com/mcp --local
```

## Kill switch

- **Zero Trust dashboard** (works from a phone): Access controls → Applications → disable either application. All traffic for that hostname stops at Cloudflare.
- **End existing sessions:** revoke them under Zero Trust → Users.
- **On the Mac:** `launchctl bootout gui/$(id -u)/ai.mynomos.imsg-tunnel` takes the tunnel down.
