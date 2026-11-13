import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixtureDb } from "../helpers/fixtures";
import { parseToolText, STUB, tempDir, waitFor } from "../helpers/harness";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");

interface Env {
  dir: string;
  configPath: string;
  env: Record<string, string>;
}

/** A temp HOME-like layout with a config that points imsg.path at the stub. */
function setup(configBody: string, stubEnv: Record<string, string> = {}): Env {
  const dir = tempDir("imsg-mcp-cli-");
  const dbPath = join(dir, "chatdb.json");
  writeFileSync(dbPath, JSON.stringify(fixtureDb()));
  const wrapper = join(dir, "imsg");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, `[imsg]\npath = "${wrapper}"\n${configBody}`, { mode: 0o600 });
  return {
    dir,
    configPath,
    env: {
      ...(process.env as Record<string, string>),
      IMSG_MCP_CONFIG: configPath,
      IMSG_MCP_STATE_DIR: join(dir, "state"),
      IMSG_MCP_LOG_DIR: join(dir, "logs"),
      STUB_IMSG_DB: dbPath,
      ...stubEnv,
    },
  };
}

async function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port!;
  await s.stop(true);
  return port;
}

describe("imsg-mcp CLI", () => {
  test("init writes a 0600 config and refuses to overwrite it", async () => {
    const dir = tempDir("imsg-mcp-init-");
    const path = join(dir, "sub", "config.toml");
    const env = { ...(process.env as Record<string, string>), IMSG_MCP_CONFIG: path };
    const first = await run(["init"], env);
    expect(first.code).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("[send]");
    const second = await run(["init"], env);
    expect(second.code).toBe(1);
    expect((await run(["init", "--force"], env)).code).toBe(0);
  });

  test("check-config summarizes the config and verifies imsg", async () => {
    const s = setup(`[send]\nenabled = true\nallowlist = ["+14155550101"]\n`);
    const res = await run(["check-config"], s.env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Sending           ON; allowlist 1");
    expect(res.stdout).toContain("RPC methods OK");
    expect(res.stdout).toContain("HTTP mode: access.team_domain is required");
  });

  test("check-config fails when imsg lacks a required RPC method", async () => {
    const s = setup("", { STUB_IMSG_STATUS_METHODS: "chats.list,messages.history,send" });
    const res = await run(["check-config"], s.env);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("missing required RPC methods: watch.subscribe");
  });

  test("an invalid config exits with EX_CONFIG (78) and says why", async () => {
    const s = setup(`[send]\nenabeld = true\n`);
    const res = await run(["serve"], s.env);
    expect(res.code).toBe(78);
    expect(res.stderr).toContain('unknown key(s) "enabeld"');
  });

  test("serve refuses to start without Cloudflare Access settings", async () => {
    const s = setup("");
    const res = await run(["serve"], s.env);
    expect(res.code).toBe(78);
    expect(res.stderr).toContain("access.team_domain is required");
  });

  test("serve refuses to start when imsg is missing a required method (EX_UNAVAILABLE)", async () => {
    const s = setup(
      `[access]\nteam_domain = "t.cloudflareaccess.com"\naud = ["a"]\npeople = ["me@example.com"]\n`,
      { STUB_IMSG_STATUS_METHODS: "chats.list,messages.history,watch.subscribe" },
    );
    const res = await run(["serve"], s.env);
    expect(res.code).toBe(69);
    expect(res.stderr).toContain("missing required RPC methods: send");
  });

  test("unknown commands are usage errors", async () => {
    const res = await run(["frobnicate"], process.env as Record<string, string>);
    expect(res.code).toBe(64);
  });
});

describe("serve process", () => {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let s: Env;
  let mcpPort: number;
  let healthPort: number;

  beforeAll(async () => {
    mcpPort = await freePort();
    healthPort = await freePort();
    s = setup(
      `[server]\nlisten = "127.0.0.1:${mcpPort}"\nhealth_listen = "127.0.0.1:${healthPort}"\n` +
        `[access]\nteam_domain = "t.cloudflareaccess.com"\naud = ["a"]\npeople = ["me@example.com"]\n`,
    );
    proc = Bun.spawn([process.execPath, CLI, "serve"], {
      env: s.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitFor(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${healthPort}/healthz`)).status > 0;
        } catch {
          return false;
        }
      },
      10_000,
      "server up",
    );
  });

  afterAll(async () => {
    proc?.kill("SIGTERM");
    await proc?.exited;
  });

  test("an unauthenticated request to the MCP port gets 403", async () => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });

  test("/healthz answers on its own port with details", async () => {
    const res = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("imsg.child_alive", true);
    expect(body).toHaveProperty("watch.subscribed");
  });

  test("writes server.log without message text, and SIGHUP reloads the config", async () => {
    writeFileSync(
      s.configPath,
      readFileSync(s.configPath, "utf8") + `[send]\nenabled = true\nallowlist = ["+14155550101"]\n`,
    );
    proc!.kill("SIGHUP");
    const logPath = join(s.dir, "logs", "server.log");
    await waitFor(
      () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("config reloaded"),
      5000,
      "reload log",
    );
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain('"send_enabled":true');
    expect(log).not.toContain("Running 10 min late");
    expect(log).not.toContain("Photo from the trip");
  });

  test("SIGTERM shuts down cleanly", async () => {
    proc!.kill("SIGTERM");
    expect(await proc!.exited).toBe(0);
    proc = undefined;
  });
});

describe("stdio mode", () => {
  test("serves MCP over stdin/stdout and follows send.enabled on SIGHUP", async () => {
    const s = setup(`[send]\nenabled = false\nallowlist = ["+14155550101"]\n`);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "stdio"],
      env: s.env,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0" });
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged += 1;
    });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("send_message");
      const chats = parseToolText(await client.callTool({ name: "list_chats", arguments: {} }));
      expect((chats.chats as unknown[]).length).toBe(5);
      const status = parseToolText(await client.callTool({ name: "get_status", arguments: {} }));
      expect(status.server).toMatchObject({ mode: "stdio" });
      expect(status.caller).toMatchObject({ identity: "local", role: "full", can_send: false });

      writeFileSync(
        s.configPath,
        readFileSync(s.configPath, "utf8").replace("enabled = false", "enabled = true"),
      );
      process.kill(transport.pid!, "SIGHUP");
      await waitFor(() => listChanged > 0, 5000, "tools/list_changed");
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("send_message");
      const sent = parseToolText(
        await client.callTool({
          name: "send_message",
          arguments: { to: "+14155550101", text: "from stdio" },
        }),
      );
      expect(sent.status).toBe("sent");
      const audit = readFileSync(join(s.dir, "logs", "audit.jsonl"), "utf8");
      expect(audit).toContain('"identity":"local"');
      expect(audit).toContain('"text":"from stdio"');
    } finally {
      await client.close();
    }
  });
});
