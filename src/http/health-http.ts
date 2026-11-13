import type { HealthMonitor } from "../ops/health";
import type { RunningServer } from "./mcp-http";

/**
 * `GET /healthz` on its own loopback port, kept out of the tunnel. 200 when healthy,
 * 503 otherwise, with the details as JSON either way. No message content.
 */
export function startHealthServer(
  monitor: HealthMonitor,
  host: string,
  port: number,
): RunningServer {
  const server = Bun.serve({
    hostname: host,
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/healthz" || (req.method !== "GET" && req.method !== "HEAD")) {
        return new Response("not found\n", { status: 404 });
      }
      const snap = monitor.snapshot();
      return new Response(JSON.stringify(snap, null, 2), {
        status: snap.healthy ? 200 : 503,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  });
  const actualPort = server.port ?? port;
  return {
    url: `http://${host}:${actualPort}/healthz`,
    port: actualPort,
    stop: async () => {
      await server.stop(true);
    },
  };
}
