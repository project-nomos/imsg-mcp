#!/usr/bin/env bun
/**
 * Development only: runs imsg-mcp in remote (HTTP) mode on this machine behind a local
 * stand-in for Cloudflare Access, so you can try the remote transport with Claude Code,
 * the MCP Inspector or any MCP client without a Cloudflare account.
 *
 *   bun scripts/dev-remote.ts                # stub imsg with demo data; sends go to the stub
 *   bun scripts/dev-remote.ts --real-imsg    # the real imsg serving a synthetic chat.db; sending off
 *   bun scripts/dev-remote.ts --port 8790
 *
 * The stand-in behaves like the two Access applications in docs/cloudflare.md:
 *   people  http://127.0.0.1:<port>/people/mcp  needs "Authorization: Bearer <dev token>",
 *           otherwise 401 with WWW-Authenticate (as with Managed OAuth)
 *   agents  http://127.0.0.1:<port>/agent/mcp   needs CF-Access-Client-Id/Secret
 * and forwards to the real server with a signed Cf-Access-Jwt-Assertion. Nothing real is
 * ever read or sent: the data is synthetic and the signing key exists only in memory.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "../src/app";
import { buildConfig } from "../src/config/schema";
import { ConfigStore } from "../src/config/store";
import { startMcpHttpServer } from "../src/http/mcp-http";
import { fakeMessagesApp } from "../src/imsg/messages-app";
import { resolveImsgPath } from "../src/imsg/status";
import { MemoryAuditLog } from "../src/log/audit";
import { createLogger } from "../src/log/logger";
import { ALICE, CAROL, fixtureDb } from "../test/helpers/fixtures";
import { buildChatDb } from "../test/helpers/synthetic-chatdb";

const argv = process.argv.slice(2);
const realImsg = argv.includes("--real-imsg");
const portArg = argv.indexOf("--port");
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 8790;

const TEAM = "dev.cloudflareaccess.com";
const AUD_PEOPLE = "dev-people";
const AUD_AGENT = "dev-agent";
const OWNER = "you@example.com";
const DEV_BEARER = `dev-${randomBytes(12).toString("hex")}`;
const TOKENS: Record<string, { secret: string; role: "read" | "read_send" }> = {
  "dev-reader.access": { secret: randomBytes(12).toString("hex"), role: "read" },
  "dev-sender.access": { secret: randomBytes(12).toString("hex"), role: "read_send" },
};
const NO_PROMPTS_PROFILE =
  '(version 1)(allow default)(deny mach-lookup (global-name "com.apple.tccd") ' +
  '(global-name "com.apple.tccd.system") (global-name "com.apple.contactsd") ' +
  '(global-name "com.apple.contactsd.persistence"))';

const dir = mkdtempSync(join(tmpdir(), "imsg-mcp-dev-remote-"));
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "dev", alg: "RS256" };

let imsgCommand: string[];
let imsgEnv: NodeJS.ProcessEnv | undefined;
let imsgDb = "";
if (realImsg) {
  imsgDb = join(dir, "chat.db");
  buildChatDb(imsgDb);
  imsgCommand = ["/usr/bin/sandbox-exec", "-p", NO_PROMPTS_PROFILE, resolveImsgPath("imsg")];
} else {
  const stubDb = join(dir, "chatdb.json");
  writeFileSync(stubDb, JSON.stringify(fixtureDb()));
  imsgCommand = [process.execPath, resolve(import.meta.dir, "../test/fixtures/stub-imsg.ts")];
  imsgEnv = { ...process.env, STUB_IMSG_DB: stubDb };
}

const config = new ConfigStore(
  join(dir, "config.toml"),
  buildConfig({
    server: { listen: "127.0.0.1:0", health_listen: "127.0.0.1:0" },
    imsg: { db: imsgDb },
    // Real imsg would really send through Messages, so sending stays off with --real-imsg.
    send: { enabled: !realImsg, allowlist: [ALICE, CAROL] },
    access: {
      team_domain: TEAM,
      aud: [AUD_PEOPLE, AUD_AGENT],
      people: [OWNER],
      service_tokens: Object.fromEntries(Object.entries(TOKENS).map(([id, t]) => [id, t.role])),
    },
  }),
);
const { logger } = createLogger({ dir: join(dir, "logs"), stderr: "warn" });
const app = await App.create({
  config,
  logger,
  audit: new MemoryAuditLog(),
  stateDbPath: join(dir, "state.db"),
  imsgCommand,
  imsgEnv,
  messagesApp: fakeMessagesApp(true),
  keySource: createLocalJWKSet({ keys: [jwk] }),
  mode: "http",
});
app.start();
const origin = startMcpHttpServer(app, "127.0.0.1", 0);

const sign = (claims: Record<string, unknown>, aud: string) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "dev" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

async function forward(req: Request, jwt: string): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const h of ["authorization", "cf-access-client-id", "cf-access-client-secret", "host"]) {
    headers.delete(h);
  }
  headers.set("cf-access-jwt-assertion", jwt);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const res = await fetch(origin.url, { method: req.method, headers, body });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

const edge = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/people/mcp") {
      if (req.headers.get("authorization") !== `Bearer ${DEV_BEARER}`) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`,
          },
        });
      }
      return forward(req, await sign({ email: OWNER, type: "app" }, AUD_PEOPLE));
    }
    if (path === "/agent/mcp") {
      const id = req.headers.get("cf-access-client-id") ?? "";
      if (!TOKENS[id] || TOKENS[id].secret !== req.headers.get("cf-access-client-secret")) {
        return new Response("Forbidden", { status: 403 });
      }
      return forward(req, await sign({ common_name: id, sub: "" }, AUD_AGENT));
    }
    return new Response("not found\n", { status: 404 });
  },
});

const peopleUrl = `http://127.0.0.1:${edge.port}/people/mcp`;
const agentUrl = `http://127.0.0.1:${edge.port}/agent/mcp`;
const mcpConfig = (url: string, headers: Record<string, string>) =>
  JSON.stringify({ mcpServers: { imessage: { type: "http", url, headers } } }, null, 2);
const peopleConfig = join(dir, "mcp-people.json");
const readerConfig = join(dir, "mcp-reader.json");
writeFileSync(peopleConfig, mcpConfig(peopleUrl, { Authorization: `Bearer ${DEV_BEARER}` }));
writeFileSync(
  readerConfig,
  mcpConfig(agentUrl, {
    "CF-Access-Client-Id": "dev-reader.access",
    "CF-Access-Client-Secret": TOKENS["dev-reader.access"]!.secret,
  }),
);

process.stdout
  .write(`imsg-mcp dev remote mode (${realImsg ? "real imsg, synthetic chat.db, sending off" : "stub imsg, demo data"})

  origin (JWT required)  ${origin.url}
  people (as ${OWNER})   ${peopleUrl}   header  Authorization: Bearer ${DEV_BEARER}
  agents                 ${agentUrl}
      read token        CF-Access-Client-Id: dev-reader.access   CF-Access-Client-Secret: ${TOKENS["dev-reader.access"]!.secret}
      read_send token   CF-Access-Client-Id: dev-sender.access   CF-Access-Client-Secret: ${TOKENS["dev-sender.access"]!.secret}

  Claude Code:  claude --mcp-config ${peopleConfig}
                claude --mcp-config ${readerConfig}
  Ctrl-C to stop.
`);

const shutdown = async () => {
  await edge.stop(true);
  await origin.stop();
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
