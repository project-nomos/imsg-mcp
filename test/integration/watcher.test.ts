import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ALICE } from "../helpers/fixtures";
import {
  accessKeys,
  connectClient,
  Harness,
  OWNER,
  parseToolText,
  waitFor,
} from "../helpers/harness";

const harnesses: Harness[] = [];

async function harness(opts: ConstructorParameters<typeof Harness>[0] = {}): Promise<Harness> {
  const h = await new Harness(opts).start();
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.stop()));
});

describe("first start", () => {
  test("a check_new_messages call right at startup waits for the backfill", async () => {
    const keys = await accessKeys();
    const h = new Harness({ start: false, keySource: keys.keySource });
    harnesses.push(h);
    await h.start();
    h.app.start();
    const url = await h.startHttp();
    const client = await connectClient(url, await keys.sign({ email: OWNER }));
    try {
      const res = parseToolText(
        await client.callTool({ name: "check_new_messages", arguments: {} }),
      );
      expect((res.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([
        13, 14, 15, 16, 17,
      ]);
    } finally {
      await client.close();
    }
  });

  test("backfills the last 24 hours of inbound messages and sets the cursor", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.inboundStats().count >= 5, 3000, "backfill");
    const stored = h.app.store.inboundAfter(0, undefined, 100).map((r) => r.rowid);
    expect(stored).toEqual([13, 14, 15, 16, 17]);
    expect(h.app.store.getCursor()).toBe(17);
  });
});

describe("sync check", () => {
  test("notices a stalled watch and resubscribes from the cursor", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    const stalled = h.app.watcher.subscriptionId!;
    h.setBehavior({ paused_subscriptions: [stalled] });

    // A message that the stalled stream never delivers, old enough to count as missed.
    const db = h.readDb();
    db.messages.push({
      id: 40,
      chat_id: 1,
      guid: "MISSED",
      sender: ALICE,
      is_from_me: false,
      text: "missed by the stream",
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    h.writeDb(db);
    await Bun.sleep(200);
    expect(h.app.store.findInbound(40)).toBeUndefined();

    const sync = await h.app.watcher.syncCheck();
    expect(sync.db_newest_rowid).toBe(40);
    expect(h.app.watcher.subscriptionId).not.toBe(stalled);
    await waitFor(() => h.app.store.findInbound(40), 3000, "missed message after resubscribe");
    expect(h.app.watcher.inSync).toBe(true);
    expect(sync.resubscribes).toBe(1);
  });

  test("a cursor far past the newest message only warns; nothing is deleted", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    const stored = h.app.store.inboundStats().count;
    h.app.store.advanceCursor(5_000_000);
    const sync = await h.app.watcher.syncCheck();
    expect(sync.note).toContain("delete state.db");
    expect(sync.error).toBeNull();
    expect(h.app.store.getCursor()).toBe(5_000_000);
    expect(h.app.store.inboundStats().count).toBe(stored);
  });

  test("a failed sync check is reported until one succeeds", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    const original = h.app.api.history.bind(h.app.api);
    h.app.api.history = async () => {
      throw new Error("simulated history failure");
    };
    const failed = await h.app.watcher.syncCheck();
    expect(failed.error).toContain("simulated history failure");
    expect(h.app.watcher.inSync).toBe(false);
    h.app.api.history = original;
    const ok = await h.app.watcher.syncCheck();
    expect(ok.error).toBeNull();
    expect(h.app.watcher.inSync).toBe(true);
  });

  test("reports in sync when nothing was missed", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    const sync = await h.app.watcher.syncCheck();
    expect(sync.behind).toBe(false);
    expect(sync.db_newest_rowid).toBe(17);
  });
});

describe("watch notifications", () => {
  test("a watch.overflow resubscribes from the resume cursor", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    const before = h.app.watcher.subscriptionId!;
    h.app.rpc.emit("notification", "watch.overflow", {
      subscription: before,
      resume_after_rowid: 17,
      reason: "buffer_limit_exceeded",
      terminal: true,
    });
    await waitFor(
      () => h.app.watcher.subscribed && h.app.watcher.subscriptionId !== before,
      3000,
      "resubscribe",
    );
    const id = h.inject({ chat_id: 1, text: "after overflow", sender: ALICE });
    await waitFor(() => h.app.store.findInbound(id), 3000, "message after overflow");
  });

  test("edits and unsends update the stored text without moving the cursor", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    const sub = h.app.watcher.subscriptionId!;
    h.app.rpc.emit("notification", "message", {
      subscription: sub,
      message: {
        id: 17,
        chat_id: 1,
        text: "Running 15 min late",
        type: "edited",
        created_at: new Date().toISOString(),
      },
    });
    expect(h.app.store.findInbound(17)).toMatchObject({
      text: "Running 15 min late",
      edited: true,
    });
    h.app.rpc.emit("notification", "message", {
      subscription: sub,
      message: {
        id: 16,
        chat_id: 5,
        text: "",
        type: "unsent",
        created_at: new Date().toISOString(),
      },
    });
    expect(h.app.store.findInbound(16)).toMatchObject({ text: "", unsent: true });
    expect(h.app.store.getCursor()).toBe(17);
  });

  test("notifications for an old subscription are ignored", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    h.app.rpc.emit("notification", "message", {
      subscription: 9999,
      message: {
        id: 500,
        chat_id: 1,
        text: "ghost",
        sender: ALICE,
        created_at: new Date().toISOString(),
      },
    });
    expect(h.app.store.findInbound(500)).toBeUndefined();
    expect(h.app.store.getCursor()).toBe(17);
  });
});

describe("robustness", () => {
  test("a failed write does not move the cursor past the message; it is replayed", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    const store = h.app.store;
    const realInsert = store.insertInbound.bind(store);
    let failures = 1;
    store.insertInbound = (row) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("disk I/O error");
      }
      return realInsert(row);
    };
    const first = h.inject({ chat_id: 1, text: "first", sender: ALICE });
    const second = h.inject({ chat_id: 1, text: "second", sender: ALICE });
    await waitFor(() => store.findInbound(second), 8000, "replayed after the failed write");
    expect(store.findInbound(first)).toMatchObject({ text: "first" });
    expect(store.getCursor()).toBe(second);
    expect(h.log.records.some((r) => r.msg === "watch notification failed")).toBe(true);
  });

  test("backlog sent before the watch.subscribe reply is not lost", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    await h.app.stop();
    const a = h.inject({ chat_id: 1, text: "while down 1", sender: ALICE });
    const b = h.inject({ chat_id: 2, text: "while down 2", sender: "+14155550102" });
    h.setBehavior({ notify_before_subscribe_reply: true });
    h.app = await h.createApp();
    h.app.start();
    await waitFor(() => h.app.store.findInbound(b), 5000, "backlog stored");
    expect(h.app.store.findInbound(a)).toBeDefined();
    expect(h.app.store.getCursor()).toBe(b);
  });

  test("history synced in from long ago is not reported as new", async () => {
    const h = await harness();
    await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill cursor");
    const db = h.readDb();
    db.messages.push({
      id: 30,
      chat_id: 2,
      guid: "ICLOUD-OLD",
      sender: "+14155550102",
      is_from_me: false,
      text: "from last year",
      created_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });
    h.writeDb(db);
    await waitFor(() => h.app.store.getCursor() === 30, 3000, "cursor past the old row");
    expect(h.app.store.findInbound(30)).toBeUndefined();
  });
});

describe("newer imsg (0.21, strict params)", () => {
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  test("every tool works against strict param validation, using messages.search and chats.get", async () => {
    const keys = await accessKeys();
    const h = await harness({ version: "0.21.0", keySource: keys.keySource });
    const url = await h.startHttp();
    client = await connectClient(url, await keys.sign({ email: OWNER }));
    expect(h.app.api.has("messages.search")).toBe(true);

    const chats = parseToolText(await client.callTool({ name: "list_chats", arguments: {} }));
    expect((chats.chats as unknown[]).length).toBe(5);
    const family = (chats.chats as { chat_id: number; name: string }[]).find(
      (c) => c.chat_id === 3,
    );
    expect(family?.name).toBe("Family");

    const history = parseToolText(
      await client.callTool({ name: "get_messages", arguments: { chat_id: 1, limit: 2 } }),
    );
    expect((history.messages as unknown[]).length).toBe(2);

    const search = parseToolText(
      await client.callTool({ name: "search_messages", arguments: { query: "dinner" } }),
    );
    expect((search.searched as { mode: string }).mode).toBe("imsg_search");
    expect((search.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([13]);

    const news = parseToolText(
      await client.callTool({ name: "check_new_messages", arguments: {} }),
    );
    expect(news.next_cursor).toBe(17);

    const sent = parseToolText(
      await client.callTool({
        name: "send_message",
        arguments: { chat_id: 1, text: "strict mode works" },
      }),
    );
    expect(sent.status).toBe("sent");

    const status = parseToolText(await client.callTool({ name: "get_status", arguments: {} }));
    expect((status.imsg as { version: string }).version).toBe("0.21.0");

    // No call was rejected for an unknown parameter.
    expect(
      h.log.records.filter((r) => String(r.error ?? "").includes("unknown parameter")),
    ).toEqual([]);
  });
});

describe("permissions", () => {
  test("missing Full Disk Access: tools explain the fix; the watch keeps retrying", async () => {
    const keys = await accessKeys();
    const h = new Harness({ start: false, keySource: keys.keySource });
    harnesses.push(h);
    h.setBehavior({ permission_denied: true });
    await h.start();
    h.app.start();
    await waitFor(() => h.app.watcher.lastError, 3000, "subscribe failure");
    expect(h.app.watcher.subscribed).toBe(false);
    const url = await h.startHttp();
    const client = await connectClient(url, await keys.sign({ email: OWNER }));
    try {
      const res = await client.callTool({ name: "list_chats", arguments: {} });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain("Full Disk Access");
    } finally {
      await client.close();
    }
    // Once access is granted, the next attempt subscribes.
    h.setBehavior({ permission_denied: false });
    await waitFor(
      async () => {
        await h.app.watcher.ensureSubscribed("test");
        return h.app.watcher.subscribed;
      },
      5000,
      "subscribe after access is granted",
    );
    expect(h.app.watcher.permissionDenied).toBe(false);
  });
});
