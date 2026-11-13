import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ImsgError } from "../../src/imsg/errors";
import { ImsgRpcClient } from "../../src/imsg/rpc-client";
import { memoryLogger } from "../../src/log/logger";
import { fixtureDb } from "../helpers/fixtures";
import { STUB, tempDir, waitFor } from "../helpers/harness";

const clients: ImsgRpcClient[] = [];

function makeClient(
  env: NodeJS.ProcessEnv,
  command = [process.execPath, STUB, "rpc"],
  timeoutMs = 2000,
) {
  const log = memoryLogger();
  const client = new ImsgRpcClient({
    command,
    logger: log.logger,
    callTimeoutMs: timeoutMs,
    restartInitialMs: 50,
    restartMaxMs: 200,
    env,
  });
  clients.push(client);
  return { client, log };
}

function stubEnv(extra: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const dir = tempDir();
  const dbPath = join(dir, "chatdb.json");
  writeFileSync(dbPath, JSON.stringify({ ...fixtureDb(), ...extra }));
  return { ...process.env, STUB_IMSG_DB: dbPath };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
});

describe("imsg rpc bridge", () => {
  test("calls methods and receives results", async () => {
    const { client } = makeClient(stubEnv());
    client.start();
    const result = await client.call<{ chats: unknown[] }>("chats.list", { limit: 2 });
    expect(result.chats).toHaveLength(2);
  });

  test("delivers notifications and keeps stderr out of the RPC stream", async () => {
    const { client, log } = makeClient(stubEnv());
    const notes: string[] = [];
    client.on("notification", (method) => notes.push(method));
    client.start();
    await client.call("watch.subscribe", {});
    await waitFor(() => log.records.some((r) => r.msg === "imsg stderr"), 3000, "stderr line");
    expect(notes).toEqual([]);
  });

  test("times out a call that never answers", async () => {
    const env = stubEnv({ behavior: { send_mode: "timeout" } });
    const { client } = makeClient(env, undefined, 300);
    client.start();
    const err = await client.call("send", { to: "+14155550101", text: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(ImsgError);
    expect((err as ImsgError).kind).toBe("timeout");
    expect((err as ImsgError).retryable).toBe(true);
  });

  test("fails in-flight calls when the child dies, then restarts it", async () => {
    const env = stubEnv({ behavior: { send_mode: "timeout" } });
    const { client } = makeClient(env, undefined, 5000);
    const generations: number[] = [];
    client.on("started", (g) => generations.push(g));
    client.start();
    const pending = client.call("send", { to: "+14155550101", text: "hi" }).catch((e) => e);
    await Bun.sleep(100);
    client.kill("SIGKILL");
    const err = await pending;
    expect(err).toBeInstanceOf(ImsgError);
    expect((err as ImsgError).kind).toBe("unavailable");
    expect((err as ImsgError).retryable).toBe(true);
    await waitFor(() => generations.length >= 2, 3000, "restart");
    expect(client.alive).toBe(true);
    expect(client.stats().restarts).toBe(1);
  });

  test("calls fail fast while the child is down", async () => {
    const { client } = makeClient(stubEnv(), ["/nonexistent/imsg", "rpc"]);
    client.start();
    await Bun.sleep(50);
    const err = await client.call("chats.list", {}).catch((e) => e);
    expect((err as ImsgError).kind).toBe("unavailable");
  });

  test("backs off between restarts, doubling up to the cap", async () => {
    const { client } = makeClient(stubEnv(), [process.execPath, "-e", "process.exit(3)"]);
    const delays: number[] = [];
    client.on("exit", (info) => {
      if (info.restartInMs !== undefined) delays.push(info.restartInMs);
    });
    client.start();
    await waitFor(() => delays.length >= 4, 5000, "several restarts");
    expect(delays.slice(0, 4)).toEqual([50, 100, 200, 200]);
  });

  test("a listener that throws does not stall the stream", async () => {
    const { client, log } = makeClient(stubEnv());
    client.on("notification", () => {
      throw new Error("listener bug");
    });
    client.start();
    await client.call("watch.subscribe", {});
    const dbPath = (client as unknown as { opts: { env: NodeJS.ProcessEnv } }).opts.env
      .STUB_IMSG_DB!;
    const db = JSON.parse(readFileSync(dbPath, "utf8"));
    db.messages.push({
      id: 99,
      chat_id: 1,
      guid: "X",
      sender: "+14155550101",
      is_from_me: false,
      text: "hi",
      created_at: new Date().toISOString(),
    });
    writeFileSync(dbPath, JSON.stringify(db));
    await waitFor(
      () => log.records.some((r) => r.msg === "notification handler failed"),
      3000,
      "listener error logged",
    );
    const after = await client.call<{ chats: unknown[] }>("chats.list", { limit: 1 });
    expect(after.chats).toHaveLength(1);
  });

  test("a child that stops answering is restarted after repeated timeouts", async () => {
    const env = stubEnv({ behavior: { send_mode: "timeout" } });
    const { client } = makeClient(env, undefined, 150);
    const generations: number[] = [];
    client.on("started", (g) => generations.push(g));
    client.start();
    for (let i = 0; i < 3; i++) {
      const err = await client.call("send", { to: "+14155550101", text: "hi" }).catch((e) => e);
      expect((err as ImsgError).kind).toBe("timeout");
    }
    await waitFor(() => generations.length >= 2, 3000, "restart after timeouts");
    expect(client.stats().consecutive_timeouts).toBe(0);
  });

  test("permission errors from imsg are classified", async () => {
    const { client } = makeClient(stubEnv({ behavior: { permission_denied: true } }));
    client.start();
    const err = await client.call("chats.list", { limit: 1 }).catch((e) => e);
    expect((err as ImsgError).kind).toBe("permission");
  });

  test("replays recorded traffic in imsg 0.8.2's shape", async () => {
    const transcript = resolve(import.meta.dir, "../fixtures/recorded/imsg-0.8.2.jsonl");
    const { client } = makeClient({ ...process.env, STUB_IMSG_REPLAY: transcript });
    client.start();
    const chats = await client.call<{ chats: Record<string, unknown>[] }>("chats.list", {
      limit: 2,
    });
    expect(chats.chats[0]).toMatchObject({ id: 42, identifier: "+14155550123", is_group: false });
    const history = await client.call<{ messages: Record<string, unknown>[] }>("messages.history", {
      chat_id: 42,
      limit: 2,
      attachments: true,
    });
    expect(history.messages[0]).toMatchObject({ id: 918233, is_from_me: false, chat_id: 42 });
    const sub = await client.call<{ subscription: number }>("watch.subscribe", {});
    expect(sub.subscription).toBe(1);
    const denied = await client.call("send", { to: "+14155550123", text: "hi" }).catch((e) => e);
    expect((denied as ImsgError).kind).toBe("permission");
  });
});
