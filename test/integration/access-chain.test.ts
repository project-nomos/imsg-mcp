/**
 * The whole request chain with a stand-in for Cloudflare Access in front of the server:
 *
 *   client → [Access emulator] → imsg-mcp origin (127.0.0.1) → imsg (stub)
 *
 * The emulator behaves like the two Access applications in docs/cloudflare.md:
 * - people host: no credentials → 401 with WWW-Authenticate (Managed OAuth); a signed-in
 *   caller is forwarded with a signed Cf-Access-Jwt-Assertion carrying their email.
 * - agent host: valid CF-Access-Client-Id/Secret → forwarded with a JWT whose
 *   common_name is the client id; anything else → 403.
 *
 * It also runs `imsg-mcp acceptance` (runAcceptance) against this chain.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runAcceptance } from "../../src/acceptance";
import { startHealthServer } from "../../src/http/health-http";
import type { RunningServer } from "../../src/http/mcp-http";
import { HealthMonitor } from "../../src/ops/health";
import {
  accessKeys,
  AUD_AGENT,
  AUD_PEOPLE,
  Harness,
  OWNER,
  parseToolText,
} from "../helpers/harness";

const TOKENS: Record<string, string> = {
  "reader.access": "reader-secret",
  "sender.access": "sender-secret",
};
const OAUTH_BEARER = "oauth:emulated-session-for-owner";

let h: Harness;
let keys: Awaited<ReturnType<typeof accessKeys>>;
let origin: string;
let health: RunningServer;
let monitor: HealthMonitor;
let edge: ReturnType<typeof Bun.serve>;
let peopleUrl: string;
let agentUrl: string;

async function forward(req: Request, jwt: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("authorization");
  headers.delete("cf-access-client-id");
  headers.delete("cf-access-client-secret");
  headers.set("cf-access-jwt-assertion", jwt);
  headers.delete("host");
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const res = await fetch(origin, { method: req.method, headers, body });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

beforeAll(async () => {
  keys = await accessKeys();
  h = await new Harness({ keySource: keys.keySource }).start();
  origin = await h.startHttp();
  monitor = new HealthMonitor(h.app);
  await monitor.checkMessagesApp();
  health = startHealthServer(monitor, "127.0.0.1", 0);

  edge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/people/mcp") {
        if (req.headers.get("authorization") !== `Bearer ${OAUTH_BEARER}`) {
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", req.url)}"`,
            },
          });
        }
        return forward(req, await keys.sign({ email: OWNER, type: "app" }, { aud: AUD_PEOPLE }));
      }
      if (path === "/agent/mcp") {
        const id = req.headers.get("cf-access-client-id") ?? "";
        const secret = req.headers.get("cf-access-client-secret") ?? "";
        if (!id || TOKENS[id] !== secret) return new Response("Forbidden", { status: 403 });
        return forward(req, await keys.sign({ common_name: id, sub: "" }, { aud: AUD_AGENT }));
      }
      return new Response("not found", { status: 404 });
    },
  });
  peopleUrl = `http://127.0.0.1:${edge.port}/people/mcp`;
  agentUrl = `http://127.0.0.1:${edge.port}/agent/mcp`;
});

afterAll(async () => {
  monitor?.stop();
  await edge?.stop(true);
  await health?.stop();
  await h?.stop();
});

describe("through the Access emulator", () => {
  test("people: no credentials → 401 at the edge; signed in → full role", async () => {
    const res = await fetch(peopleUrl, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");

    const client = new Client({ name: "emulated-claude", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(peopleUrl), {
        requestInit: { headers: { authorization: `Bearer ${OAUTH_BEARER}` } },
      }),
    );
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("send_message");
      const status = parseToolText(await client.callTool({ name: "get_status", arguments: {} }));
      expect(status.caller).toMatchObject({ identity: OWNER, kind: "person", role: "full" });
    } finally {
      await client.close();
    }
  });

  test("agents: a bad service token is stopped at the edge; a good one gets its role", async () => {
    const bad = await fetch(agentUrl, {
      method: "POST",
      headers: { "CF-Access-Client-Id": "reader.access", "CF-Access-Client-Secret": "wrong" },
      body: "{}",
    });
    expect(bad.status).toBe(403);
  });

  test("imsg-mcp acceptance passes against the chain, including the refusal test", async () => {
    const lines: string[] = [];
    const ok = await runAcceptance(
      {
        publicUrl: peopleUrl,
        agentUrl,
        readToken: { id: "reader.access", secret: "reader-secret" },
        sendToken: { id: "sender.access", secret: "sender-secret" },
        localMcpUrl: origin,
        healthUrl: health.url,
        refusalTest: true,
      },
      (l) => lines.push(l),
    );
    const output = lines.join("\n");
    expect(output).toContain("PASS  people hostname answers 401 with WWW-Authenticate");
    expect(output).toContain("PASS  origin answers 403 without a JWT");
    expect(output).toContain("PASS  /healthz reports healthy");
    expect(output).toContain("PASS  a read token cannot see send_message");
    expect(output).toContain("PASS  check_new_messages answers in under 5 s");
    expect(output).toContain("PASS  watch is healthy");
    expect(output).toContain("PASS  send_message is listed (send.enabled = true)");
    expect(output).toContain(
      "PASS  a send to +15550100 (not allowlisted) is refused by the server",
    );
    expect(output).not.toContain("FAIL");
    expect(ok).toBe(true);
    // The refused send was audited and nothing went out.
    expect(h.audit.records.at(-1)).toMatchObject({ status: "refused", rule: "allowlist" });
    expect(h.readDb().messages.filter((m) => m.is_from_me && Number(m.id) > 17)).toEqual([]);
  });

  test("acceptance flags Managed OAuth being off (a redirect instead of 401)", async () => {
    const redirecting = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.cloudflareaccess.com/login" },
        }),
    });
    try {
      const lines: string[] = [];
      const ok = await runAcceptance(
        { publicUrl: `http://127.0.0.1:${redirecting.port}/mcp` },
        (l) => lines.push(l),
      );
      expect(ok).toBe(false);
      expect(lines.join("\n")).toContain("turn on Managed OAuth");
    } finally {
      await redirecting.stop(true);
    }
  });
});
