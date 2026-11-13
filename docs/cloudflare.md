# Cloudflare Tunnel and Access

In remote mode, one outbound Cloudflare Tunnel publishes two hostnames for the same local server, and Cloudflare Access sits in front of both. No request reaches the Mac without a valid sign-in, and the Mac accepts no inbound connections.

The hostnames must be on a zone in the **same Cloudflare account** as your Zero Trust organization (a Managed OAuth requirement). The examples use `imsg.example.com` and `imsg-agent.example.com`.

## 1. Tunnel

Create a tunnel managed from the dashboard, then install it on the Mac.

1. Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared. Name it `mac-mini`.
2. Copy the install token and run on the Mac:

   ```bash
   sudo cloudflared service install <token>
   ```

   This installs a LaunchDaemon running as root that restarts on failure.

3. Add two **public hostnames**, both pointing at the local server:

   | Hostname                 | Service                 |
   | ------------------------ | ----------------------- |
   | `imsg.example.com`       | `http://127.0.0.1:8787` |
   | `imsg-agent.example.com` | `http://127.0.0.1:8787` |

   The tunnel's catch-all stays `http_status:404`. Do **not** publish the health port (8788).

Use `127.0.0.1` rather than `localhost`: the server listens on IPv4 loopback only. No router port forwarding and no inbound firewall rule are needed. (A locally-managed tunnel works too; see [`deploy/cloudflared/config.example.yml`](../deploy/cloudflared/config.example.yml).)

## 2. Access application for people (Managed OAuth)

Used by Claude on the web, desktop and mobile (and Claude apps that use your account's connectors, such as Claude Duet), and by Claude Code.

1. Zero Trust → Access controls → Applications → Add an application → Self-hosted.
2. Domain: `imsg.example.com`.
3. Policy: **Allow**, include **Emails**: your address. Nobody else.
4. Login method: an identity provider with MFA (for example Google), or Cloudflare one-time PIN.
5. Advanced settings → turn on **Managed OAuth**, then:
   - **Dynamic client registration**: on. Claude uses a Client ID Metadata Document only when the server advertises one; otherwise it registers itself dynamically.
   - **Allowed redirect URIs**: `https://claude.ai/api/mcp/auth_callback` (Claude web, desktop and mobile).
   - **Allow localhost clients** and **Allow loopback clients**: on. Claude Code signs in through a loopback redirect on a random port.
   - **Access token lifetime**: 15 minutes. **Grant session duration**: 14 days.
6. Save, then copy the application's **AUD tag** (Overview tab) into `access.aud`.

With Managed OAuth on, Access answers unauthenticated requests with `401` and a `WWW-Authenticate` header pointing at its OAuth discovery metadata, instead of a browser redirect that agents cannot follow. Cloudflare requires clients that support RFC 8707 resource indicators; confirm sign-in works from each Claude surface during rollout.

## 3. Access application for machines (service tokens)

Used by Agent SDK agents and other headless clients that cannot do an interactive sign-in.

1. Zero Trust → Access controls → Service credentials → Service tokens → Create. One token per agent. Note the **Client ID** (it looks like `0123456789abcdef.access`) and **Client Secret**.
2. Add a second self-hosted application for `imsg-agent.example.com`.
3. Policy: action **Service Auth**, include **Service Token**: the tokens you created.
4. Copy this application's AUD tag into `access.aud` as well.
5. Map each token to a role in the config. Give agents `read` unless they truly need to send:

   ```toml
   [access.service_tokens]
   "0123456789abcdef.access" = "read"
   "fedcba9876543210.access" = "read_send"
   ```

Clients send the token as two headers, `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Cloudflare checks them and forwards a JWT whose `common_name` claim is the client id. Store secrets in environment variables or a secrets manager, never in code. Tokens are renewed yearly; rotate or revoke them in the dashboard.

**Why two hostnames?** Cloudflare's docs do not say whether Managed OAuth and Service Auth can share one application, and separate applications also let machines get a narrower role.

|                | People (OAuth)                             | Machines (service token)                                    |
| -------------- | ------------------------------------------ | ----------------------------------------------------------- |
| Hostname       | `imsg.example.com`                         | `imsg-agent.example.com`                                    |
| Used by        | Claude web, desktop, mobile; Claude Code   | Agent SDK and other headless agents                         |
| Policy         | Allow, include your email                  | Service Auth, include named service tokens                  |
| Sign-in        | Managed OAuth through an identity provider | `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers |
| Token lifetime | Access token 15 min; grant session 14 days | Service token renewed yearly                                |
| Server role    | `full` (read, plus send if enabled)        | Per token: `read` or `read_send`                            |

## 4. Server config

```toml
[access]
team_domain = "yourteam.cloudflareaccess.com"   # Zero Trust → Settings → Custom pages / team domain
aud = ["<AUD tag of the people app>", "<AUD tag of the machine app>"]
people = ["you@example.com"]

[access.service_tokens]
"0123456789abcdef.access" = "read"
```

Reload with `launchctl kill SIGHUP gui/$(id -u imsgbot)/ai.mynomos.imsg-mcp` (as root) or restart the agent.

### Optional: limit the people app to Anthropic's network

Claude on the web, desktop and mobile (and apps that use your account's connectors) call the server from Anthropic's cloud, from `160.79.104.0/21` ([Anthropic IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)). Claude Code calls from your own machine. If you only use the hosted apps, a Cloudflare WAF rule that blocks other sources for `imsg.example.com` adds a layer in front of Access.

## What the origin trusts

Access tokens are opaque to clients. Cloudflare checks each one and sends the origin a signed `Cf-Access-Jwt-Assertion` header, which `imsg-mcp` validates on every request: RS256 signature against `https://<team_domain>/cdn-cgi/access/certs` (keys cached and re-fetched on rotation), `iss` equal to `https://<team_domain>`, `aud` one of `access.aud`, and `exp`/`nbf` within `access.clock_tolerance_seconds`. A missing or invalid token gets `403`. The server trusts nothing else: not the source IP, not the `Host` header, not `Cf-Access-Authenticated-User-Email` or any other forwarded header.

## Verify

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

Or run the automated checks (see [testing.md](testing.md#acceptance-checklist)):

```bash
IMSG_ACCEPTANCE_READ_ID=... IMSG_ACCEPTANCE_READ_SECRET=... \
  imsg-mcp acceptance --public-url https://imsg.example.com/mcp --agent-url https://imsg-agent.example.com/mcp --local
```

## Kill switch

Zero Trust dashboard (works from a phone) → Access controls → Applications → disable either application. All traffic for that hostname stops at Cloudflare. To end existing sessions, revoke them under Zero Trust → Users.
