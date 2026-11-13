/**
 * The server against the REAL imsg binary, serving a synthetic chat.db.
 *
 * Opt-in (macOS with imsg installed): IMSG_MCP_TEST_REAL_IMSG=1 bun test test/integration/real-imsg.test.ts
 * (set IMSG_MCP_TEST_IMSG=/path/to/imsg to test a specific imsg build)
 *
 * - imsg runs with `--db <synthetic chat.db>`, so it needs no Full Disk Access and never
 *   sees anyone's messages.
 * - Sending stays disabled: send_message is not even registered, so nothing can go out.
 * - imsg asks for Contacts access when it starts. To make sure that can never pop up a
 *   permission dialog, it runs under sandbox-exec with the TCC and Contacts services
 *   unreachable; imsg then simply runs without contact names.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../../src/app";
import { buildConfig } from "../../src/config/schema";
import { ConfigStore } from "../../src/config/store";
import { startMcpHttpServer, type RunningServer } from "../../src/http/mcp-http";
import { fakeMessagesApp } from "../../src/imsg/messages-app";
import { resolveImsgPath } from "../../src/imsg/status";
import { MemoryAuditLog } from "../../src/log/audit";
import { memoryLogger } from "../../src/log/logger";
import { runSelftest } from "../../src/selftest";
import {
  accessKeys,
  AUD_AGENT,
  baseConfig,
  connectClient,
  OWNER,
  parseToolText,
  waitFor,
} from "../helpers/harness";
import { appendChatDbMessage, buildChatDb } from "../helpers/synthetic-chatdb";

/** The imsg under test: IMSG_MCP_TEST_IMSG, or the one on PATH / in Homebrew. */
const IMSG = process.env.IMSG_MCP_TEST_IMSG || resolveImsgPath("imsg");
const ENABLED =
  process.env.IMSG_MCP_TEST_REAL_IMSG === "1" && process.platform === "darwin" && existsSync(IMSG);

/** No TCC or Contacts daemons inside: no permission dialog can be shown. */
const NO_PROMPTS_PROFILE =
  '(version 1)(allow default)(deny mach-lookup (global-name "com.apple.tccd") ' +
  '(global-name "com.apple.tccd.system") (global-name "com.apple.contactsd") ' +
  '(global-name "com.apple.contactsd.persistence"))';
const IMSG_COMMAND = ["/usr/bin/sandbox-exec", "-p", NO_PROMPTS_PROFILE, IMSG];

let dir: string;
let chatDb: string;
let statePath: string;
let config: ConfigStore;
let app: App;
let http: RunningServer;
let owner: Client;
let keys: Awaited<ReturnType<typeof accessKeys>>;
const audit = new MemoryAuditLog();
const log = memoryLogger();

async function startApp(): Promise<void> {
  app = await App.create({
    config,
    logger: log.logger,
    audit,
    stateDbPath: statePath,
    imsgCommand: IMSG_COMMAND,
    messagesApp: fakeMessagesApp(true),
    keySource: keys.keySource,
    mode: "http",
  });
  app.start();
  await waitFor(() => app.watcher.subscribed, 15_000, "real imsg watch subscription");
  http = startMcpHttpServer(app, "127.0.0.1", 0);
  owner = await connectClient(http.url, await keys.sign({ email: OWNER }));
}

async function stopApp(): Promise<void> {
  await owner?.close();
  await http?.stop();
  await app?.stop();
}

async function call(name: string, args: Record<string, unknown> = {}) {
  return parseToolText(await owner.callTool({ name, arguments: args }));
}

describe.skipIf(!ENABLED)("real imsg (synthetic chat.db, sending disabled)", () => {
  beforeAll(async () => {
    keys = await accessKeys();
    dir = mkdtempSync(join(tmpdir(), "imsg-mcp-real-"));
    chatDb = join(dir, "chat.db");
    statePath = join(dir, "state.db");
    buildChatDb(chatDb);
    config = new ConfigStore(
      join(dir, "config.toml"),
      buildConfig(
        baseConfig({ imsg: { db: chatDb, call_timeout_ms: 10_000 }, send: { enabled: false } }),
      ),
    );
    await startApp();
  }, 30_000);

  afterAll(async () => {
    await stopApp();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the real imsg passes the startup check and reports its version", async () => {
    const status = await call("get_status");
    expect((status.imsg as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);
    expect((status.imsg as { rpc_methods: string[] }).rpc_methods).toEqual(
      expect.arrayContaining(["chats.list", "messages.history", "watch.subscribe", "send"]),
    );
    expect((status.send as { enabled: boolean }).enabled).toBe(false);
  });

  test("send_message does not exist, so nothing can be sent", async () => {
    const { tools } = await owner.listTools();
    expect(tools.map((t) => t.name)).not.toContain("send_message");
  });

  test("list_chats maps real chats.list payloads", async () => {
    const res = await call("list_chats");
    const chats = res.chats as {
      chat_id: number;
      name: string;
      is_group: boolean;
      participants: string[];
    }[];
    expect(chats.map((c) => c.chat_id)).toEqual([1, 5, 4, 3, 2]);
    // 1:1 chats have no display name in imsg 0.8; the handle stands in.
    expect(chats[0]).toMatchObject({
      name: "+14155550101",
      is_group: false,
      participants: ["+14155550101"],
    });
    expect(chats.find((c) => c.chat_id === 3)).toMatchObject({ name: "Family", is_group: true });
  });

  test("get_messages returns real history oldest to newest, with attachment metadata only", async () => {
    const res = await call("get_messages", { chat_id: 1 });
    const messages = res.messages as Record<string, unknown>[];
    expect(messages.map((m) => m.cursor)).toEqual([10, 12, 14, 17]);
    expect(messages[2]).toMatchObject({
      text: "Photo from the trip",
      service: "iMessage",
      attachments: [{ name: "IMG_0412.HEIC", mime: "image/heic", bytes: 2104331, missing: true }],
    });
    expect(JSON.stringify(res)).not.toContain("/Library/Messages/Attachments");
    expect(res.untrusted_content).toBe(true);
  });

  test("get_messages pages back with before_cursor through real time-based history", async () => {
    const page1 = await call("get_messages", { chat_id: 1, limit: 2 });
    expect((page1.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([14, 17]);
    const page2 = await call("get_messages", {
      chat_id: 1,
      limit: 2,
      before_cursor: page1.prev_cursor,
    });
    expect((page2.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([10, 12]);
  });

  test("the first start backfilled the last 24 hours from real history", async () => {
    const res = await call("check_new_messages");
    expect((res.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([
      13, 14, 15, 16, 17,
    ]);
    expect(res.next_cursor).toBe(17);
  });

  test("new messages arrive through the real watch stream", async () => {
    const id = appendChatDbMessage(chatDb, {
      chat_id: 2,
      text: "live from chat.db",
      sender: "+14155550102",
    });
    await waitFor(() => app.store.findInbound(id), 10_000, "real watch notification");
    const res = await call("check_new_messages", { since_cursor: 17 });
    expect(res.messages).toEqual([
      expect.objectContaining({
        cursor: id,
        text: "live from chat.db",
        sender: "+14155550102",
        chat_id: 2,
      }),
    ]);
  });

  test("outgoing rows move the cursor but are not reported as new", async () => {
    const mine = appendChatDbMessage(chatDb, { chat_id: 1, text: "my reply", is_from_me: true });
    await waitFor(() => app.store.getCursor() >= mine, 10_000, "cursor past my own row");
    expect(app.store.findInbound(mine)).toBeUndefined();
  });

  test("nothing is lost across a server restart (real since_rowid replay)", async () => {
    const cursor = app.store.getCursor();
    await stopApp();
    const a = appendChatDbMessage(chatDb, {
      chat_id: 4,
      text: "while down 1",
      sender: "carol@example.com",
    });
    const b = appendChatDbMessage(chatDb, {
      chat_id: 1,
      text: "while down 2",
      sender: "+14155550101",
    });
    await startApp();
    await waitFor(() => app.store.findInbound(b), 10_000, "replay after restart");
    const res = await call("check_new_messages", { since_cursor: cursor });
    expect((res.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([a, b]);
  }, 40_000);

  test("a crashed imsg child restarts and resubscribes without losing messages", async () => {
    const before = app.rpc.generation;
    app.rpc.kill("SIGKILL");
    const id = appendChatDbMessage(chatDb, {
      chat_id: 2,
      text: "during the crash",
      sender: "+14155550102",
    });
    await waitFor(() => app.rpc.generation > before && app.watcher.subscribed, 15_000, "restart");
    await waitFor(() => app.store.findInbound(id), 10_000, "replayed after the crash");
  }, 30_000);

  test("search_messages scans real history", async () => {
    const res = await call("search_messages", { query: "dinner" });
    expect((res.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([13]);
  });

  test("the sync check agrees with real history", async () => {
    const sync = await app.watcher.syncCheck();
    expect(sync.error).toBeNull();
    expect(sync.behind).toBe(false);
  });

  test("a read service token sees the same data", async () => {
    const reader = await connectClient(
      http.url,
      await keys.sign({ common_name: "reader.access" }, { aud: AUD_AGENT }),
    );
    try {
      const res = parseToolText(
        await reader.callTool({ name: "list_chats", arguments: { query: "family" } }),
      );
      expect((res.chats as { chat_id: number }[]).map((c) => c.chat_id)).toEqual([3]);
    } finally {
      await reader.close();
    }
  });

  test("the selftest passes its read-only steps against the real imsg", async () => {
    const lines: string[] = [];
    const ok = await runSelftest({
      config,
      logger: log.logger,
      audit,
      stateDbPath: join(dir, "selftest-state.db"),
      send: false,
      waitForReply: false,
      out: (l) => lines.push(l),
      imsgCommand: IMSG_COMMAND,
      messagesApp: fakeMessagesApp(true),
    });
    const output = lines.join("\n");
    expect(output).toContain("PASS  read chats");
    expect(output).toContain("PASS  read history");
    expect(output).toContain("PASS  watch");
    expect(ok).toBe(true);
  }, 30_000);
});
