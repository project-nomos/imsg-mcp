import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHealthServer } from "../../src/http/health-http";
import { HealthMonitor } from "../../src/ops/health";
import { accessKeys, AUD_PEOPLE, Harness, OWNER } from "../helpers/harness";

let h: Harness;
let keys: Awaited<ReturnType<typeof accessKeys>>;
let url: string;

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "curl", version: "0" },
  },
};

function post(headers: Record<string, string>, body: unknown = INIT, target = url) {
  return fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  keys = await accessKeys();
  h = await new Harness({ keySource: keys.keySource }).start();
  url = await h.startHttp();
});

afterAll(async () => {
  await h?.stop();
});

describe("origin authentication", () => {
  test("no Cf-Access-Jwt-Assertion header: 403", async () => {
    const res = await post({});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("forwarded identity headers alone are not trusted: 403", async () => {
    const res = await post({
      "Cf-Access-Authenticated-User-Email": OWNER,
      "X-Forwarded-For": "127.0.0.1",
      "CF-Access-Client-Id": "reader.access",
    });
    expect(res.status).toBe(403);
  });

  test("wrong aud, expired, or unknown person: 403", async () => {
    expect(
      (
        await post({
          "Cf-Access-Jwt-Assertion": await keys.sign({ email: OWNER }, { aud: "other" }),
        })
      ).status,
    ).toBe(403);
    const expired = await keys.sign({ email: OWNER }, { exp: Math.floor(Date.now() / 1000) - 120 });
    expect((await post({ "Cf-Access-Jwt-Assertion": expired })).status).toBe(403);
    const stranger = await keys.sign({ email: "someone@example.com" }, { aud: AUD_PEOPLE });
    expect((await post({ "Cf-Access-Jwt-Assertion": stranger })).status).toBe(403);
    const rejected = h.log.records.filter((r) => r.msg === "request rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(3);
    // The token itself never reaches the log.
    expect(JSON.stringify(rejected)).not.toContain(expired);
  });

  test("a valid token initializes", async () => {
    const res = await post({ "Cf-Access-Jwt-Assertion": await keys.sign({ email: OWNER }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; instructions: string };
    };
    expect(body.result.serverInfo.name).toBe("imsg-mcp");
    expect(body.result.instructions).toContain("check_new_messages");
  });

  test("GET and DELETE are 405 in stateless mode; other paths are 404", async () => {
    const token = await keys.sign({ email: OWNER });
    const get = await fetch(url, { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const del = await fetch(url, {
      method: "DELETE",
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(del.status).toBe(405);
    const other = await fetch(url.replace("/mcp", "/admin"), {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(other.status).toBe(404);
  });

  test("an unauthenticated GET is also 403 (auth comes before anything else)", async () => {
    expect((await fetch(url)).status).toBe(403);
  });
});

describe("health endpoint", () => {
  test("reports healthy with details, and 503 when Messages is down", async () => {
    const monitor = new HealthMonitor(
      h.app,
      (async () => new Response("ok")) as unknown as typeof fetch,
    );
    await monitor.checkMessagesApp();
    const server = startHealthServer(monitor, "127.0.0.1", 0);
    try {
      const ok = await fetch(server.url);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ healthy: true, messages_app_running: true });
      expect((body.imsg as { child_alive: boolean }).child_alive).toBe(true);
      expect((body.watch as { subscribed: boolean }).subscribed).toBe(true);
      expect(body).toHaveProperty("watch.seconds_since_last_event");
      expect(body).toHaveProperty("last_history_ok_at");

      h.app.config.set({
        ...h.app.config.current,
        health: { ...h.app.config.current.health, relaunch_messages: false },
      });
      h.messagesApp.running = false;
      await monitor.checkMessagesApp();
      const down = await fetch(server.url);
      expect(down.status).toBe(503);
      expect(((await down.json()) as { problems: string[] }).problems).toContain(
        "Messages.app is not running",
      );
      expect((await fetch(server.url.replace("/healthz", "/mcp"))).status).toBe(404);
    } finally {
      h.messagesApp.running = true;
      await server.stop();
    }
  });

  test("a failed sync check makes /healthz unhealthy", async () => {
    const monitor = new HealthMonitor(h.app);
    await monitor.checkMessagesApp();
    const original = h.app.api.history.bind(h.app.api);
    h.app.api.history = async () => {
      throw new Error("imsg stopped answering");
    };
    try {
      await monitor.syncCheck();
      const snap = monitor.snapshot();
      expect(snap.healthy).toBe(false);
      expect(snap.problems.join()).toContain("sync check failed");
    } finally {
      h.app.api.history = original;
      await h.app.watcher.syncCheck();
      monitor.stop();
    }
    expect(monitor.snapshot().healthy).toBe(true);
  });

  test("relaunches Messages.app when it is not running", async () => {
    const monitor = new HealthMonitor(h.app);
    h.app.config.set({
      ...h.app.config.current,
      health: { ...h.app.config.current.health, relaunch_messages: true },
    });
    h.messagesApp.running = false;
    const launches = h.messagesApp.launches;
    expect(await monitor.checkMessagesApp()).toBe(true);
    expect(h.messagesApp.launches).toBe(launches + 1);
  });

  test("the heartbeat goes out only while healthy", async () => {
    const pings: string[] = [];
    const fakeFetch = (async (u: string) => {
      pings.push(String(u));
      return new Response("ok");
    }) as unknown as typeof fetch;
    const monitor = new HealthMonitor(h.app, fakeFetch);
    const cfg = h.app.config.current;
    h.app.config.set({
      ...cfg,
      heartbeat: { ...cfg.heartbeat, url: "https://hc-ping.com/test-uuid" },
    });
    await monitor.checkMessagesApp();
    expect(await monitor.heartbeat()).toBe(true);
    expect(pings).toEqual(["https://hc-ping.com/test-uuid"]);

    h.app.config.set({
      ...h.app.config.current,
      health: { ...h.app.config.current.health, relaunch_messages: false },
    });
    h.messagesApp.running = false;
    await monitor.checkMessagesApp();
    expect(await monitor.heartbeat()).toBe(false);
    expect(pings).toHaveLength(1);
    h.messagesApp.running = true;
    h.app.config.set(cfg);
  });
});
