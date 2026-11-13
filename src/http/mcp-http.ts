import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { App } from "../app";
import { ACCESS_JWT_HEADER, AccessDenied, resolveIdentity, type Identity } from "../auth/access";
import { createMcpServer } from "../mcp/server";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/**
 * Request handler for `/mcp`:
 *
 * 1. Verify `Cf-Access-Jwt-Assertion` (signature, `aud`, `iss`, `exp`). Anything else
 *    gets `403`, even though Cloudflare Access should never forward it.
 * 2. Map the identity to a role (person: full; service token: its configured role).
 * 3. Serve MCP over Streamable HTTP in stateless mode: a fresh server per request,
 *    JSON responses, no sessions.
 */
export function createMcpHandler(app: App): (req: Request) => Promise<Response> {
  return async (req) => {
    const started = app.now();
    const url = new URL(req.url);
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
      return json(404, { error: "not_found" });
    }

    let identity: Identity;
    try {
      const payload = await app.accessVerifier().verify(req.headers.get(ACCESS_JWT_HEADER));
      identity = resolveIdentity(payload, app.config.current.access);
    } catch (err) {
      const reason = err instanceof AccessDenied ? err.reason : (err as Error).message;
      app.logger.warn("request rejected", { status: 403, reason, method: req.method });
      return json(403, { error: "forbidden" });
    }

    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
      return json(
        405,
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        { allow: "POST" },
      );
    }

    const { server } = createMcpServer(app, identity);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(req);
      app.logger.info("mcp request", {
        identity: identity.id,
        kind: identity.kind,
        status: res.status,
        duration_ms: app.now() - started,
      });
      return res;
    } catch (err) {
      app.logger.error("mcp request failed", { identity: identity.id, error: err as Error });
      return json(500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    } finally {
      // JSON-response mode has already built the full body, so this is safe.
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    }
  };
}

export interface RunningServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export function startMcpHttpServer(app: App, host: string, port: number): RunningServer {
  const handler = createMcpHandler(app);
  const server = Bun.serve({
    hostname: host,
    port,
    // Sends wait up to ~10 s for confirmation; keep idle connections open well past that.
    idleTimeout: 120,
    fetch: handler,
    error(err) {
      app.logger.error("http server error", { error: err });
      return json(500, { error: "internal_error" });
    },
  });
  const actualPort = server.port ?? port;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${actualPort}/mcp`,
    port: actualPort,
    stop: async () => {
      await server.stop(true);
    },
  };
}
