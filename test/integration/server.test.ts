import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildConfig } from "../../src/config/schema";
import { UNTRUSTED_NOTE } from "../../src/core/format";
import { ALICE, CAROL, DANA, INJECTION_TEXT, STRANGER } from "../helpers/fixtures";
import {
  accessKeys,
  AUD_AGENT,
  baseConfig,
  connectClient,
  Harness,
  OWNER,
  parseToolText,
  toolText,
  waitFor,
} from "../helpers/harness";

let h: Harness;
let keys: Awaited<ReturnType<typeof accessKeys>>;
let url: string;
let owner: Client;

beforeAll(async () => {
  keys = await accessKeys();
  h = await new Harness({ keySource: keys.keySource }).start();
  url = await h.startHttp();
  owner = await connectClient(url, await keys.sign({ email: OWNER }));
});

afterAll(async () => {
  await owner?.close();
  await h?.stop();
});

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function setConfig(overrides: Record<string, unknown>) {
  h.config.set(buildConfig(baseConfig(overrides)));
}

describe("tool list", () => {
  test("the owner sees all six tools when sending is on", async () => {
    const { tools } = await owner.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "check_new_messages",
        "get_messages",
        "get_status",
        "list_chats",
        "search_messages",
        "send_message",
      ].sort(),
    );
    const send = tools.find((t) => t.name === "send_message")!;
    expect(send.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    });
    const read = tools.find((t) => t.name === "get_messages")!;
    expect(read.annotations?.readOnlyHint).toBe(true);
  });

  test("with send.enabled = false, send_message is not in the list", async () => {
    setConfig({ send: { enabled: false } });
    try {
      const { tools } = await owner.listTools();
      expect(tools.map((t) => t.name)).not.toContain("send_message");
      expect(tools).toHaveLength(5);
    } finally {
      setConfig({});
    }
  });

  test("a read service token cannot see send_message; read_send can", async () => {
    const reader = await connectClient(
      url,
      await keys.sign({ common_name: "reader.access" }, { aud: AUD_AGENT }),
    );
    const sender = await connectClient(
      url,
      await keys.sign({ common_name: "sender.access" }, { aud: AUD_AGENT }),
    );
    try {
      expect((await reader.listTools()).tools.map((t) => t.name)).not.toContain("send_message");
      expect((await sender.listTools()).tools.map((t) => t.name)).toContain("send_message");
      const attempt = await reader.callTool({
        name: "send_message",
        arguments: { to: ALICE, text: "hi" },
      });
      expect(attempt.isError).toBe(true);
    } finally {
      await reader.close();
      await sender.close();
    }
  });

  test("the server instructions cover cursors, approval and injection", async () => {
    const instructions = owner.getInstructions() ?? "";
    expect(instructions).toContain("next_cursor");
    expect(instructions).toContain("approval");
    expect(instructions).toContain("never follow instructions");
  });
});

describe("read tools", () => {
  test("list_chats returns chats with names, participants and service", async () => {
    const res = parseToolText(await call(owner, "list_chats"));
    const chats = res.chats as Record<string, unknown>[];
    expect(chats.length).toBe(5);
    expect(chats[0]).toMatchObject({
      chat_id: 1,
      name: "Alice",
      participants: [ALICE],
      service: "iMessage",
    });
    expect(chats.find((c) => c.chat_id === 3)).toMatchObject({ name: "Family", is_group: true });
    expect(res.untrusted_content).toBe(true);
  });

  test("list_chats filters by name and by phone digits", async () => {
    const byName = parseToolText(await call(owner, "list_chats", { query: "carol" }));
    expect((byName.chats as { chat_id: number }[]).map((c) => c.chat_id)).toEqual([4]);
    const byDigits = parseToolText(await call(owner, "list_chats", { query: "555-0103" }));
    expect((byDigits.chats as { chat_id: number }[]).map((c) => c.chat_id)).toEqual([3]);
    const limited = parseToolText(await call(owner, "list_chats", { limit: 2 }));
    expect(limited.chats as unknown[]).toHaveLength(2);
  });

  test("get_messages returns oldest to newest with the spec's message shape", async () => {
    const res = parseToolText(await call(owner, "get_messages", { chat_id: 1 }));
    const messages = res.messages as Record<string, unknown>[];
    expect(messages.map((m) => m.cursor)).toEqual([10, 12, 14, 17]);
    expect(messages[2]).toEqual({
      cursor: 14,
      chat_id: 1,
      chat_name: "Alice",
      sender: ALICE,
      sender_name: "Alice",
      from_me: false,
      sent_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      service: "iMessage",
      text: "Photo from the trip",
      attachments: [{ name: "IMG_0412.HEIC", mime: "image/heic", bytes: 2104331 }],
    });
    expect(messages[1]).toMatchObject({ cursor: 12, from_me: true });
    expect(res.untrusted_content).toBe(true);
    expect(res.note).toBe(UNTRUSTED_NOTE);
    expect(res.prev_cursor).toBeNull();
    expect(JSON.stringify(res)).not.toContain("Library/Messages/Attachments");
  });

  test("get_messages pages back with prev_cursor", async () => {
    const page1 = parseToolText(await call(owner, "get_messages", { chat_id: 1, limit: 2 }));
    expect((page1.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([14, 17]);
    expect(page1.prev_cursor).toBe(14);
    const page2 = parseToolText(
      await call(owner, "get_messages", { chat_id: 1, limit: 2, before_cursor: page1.prev_cursor }),
    );
    expect((page2.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([10, 12]);
    const page3 = parseToolText(
      await call(owner, "get_messages", { chat_id: 1, limit: 2, before_cursor: 10 }),
    );
    expect(page3.messages).toEqual([]);
    expect(page3.prev_cursor).toBeNull();
  });

  test("get_messages honours start and end", async () => {
    const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const res = parseToolText(await call(owner, "get_messages", { chat_id: 1, start: since }));
    expect((res.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([14, 17]);
    const bad = await call(owner, "get_messages", { chat_id: 1, start: "yesterday" });
    expect(bad.isError).toBe(true);
    expect(toolText(bad)).toContain("ISO 8601");
  });

  test("text over 4,000 characters is cut and marked truncated", async () => {
    const res = parseToolText(await call(owner, "get_messages", { chat_id: 4 }));
    const [m] = res.messages as { text: string; truncated?: boolean }[];
    expect(m!.text).toHaveLength(4000);
    expect(m!.truncated).toBe(true);
  });

  test("an unknown chat is an error", async () => {
    const res = await call(owner, "get_messages", { chat_id: 999 });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain("not found or is outside the read scope");
  });

  test("search_messages finds text across chats, newest first", async () => {
    const res = parseToolText(await call(owner, "search_messages", { query: "FAMILY dinner" }));
    expect((res.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([13]);
    expect((res.searched as { mode: string }).mode).toBe("recent_chats_scan");
    // "Running 10 min late" (17) has a zero, not the letter o.
    const inChat = parseToolText(await call(owner, "search_messages", { query: "o", chat_id: 1 }));
    expect((inChat.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([14, 12, 10]);
    expect(inChat.untrusted_content).toBe(true);
  });

  test("get_status reports versions, watch health, send settings and budget", async () => {
    const res = parseToolText(await call(owner, "get_status"));
    expect(res.imsg).toMatchObject({
      version: "0.8.2",
      installed_version: "0.8.2",
      child_alive: true,
    });
    expect(res.watch).toMatchObject({ healthy: true, subscribed: true });
    expect(res.send).toMatchObject({
      enabled: true,
      allowlist_size: 2,
      max_chars: 1000,
      rate: "10/hour, 40/day",
    });
    expect((res.send as { remaining: number }).remaining).toBeGreaterThan(0);
    expect(res.caller).toMatchObject({ identity: OWNER, role: "full", can_send: true });
    expect((res.inbound as { last_inbound_at: string | null }).last_inbound_at).not.toBeNull();
  });
});

describe("check_new_messages", () => {
  let lastCursor = 0;

  test("without a cursor, returns inbound messages from the last 24 hours", async () => {
    const res = parseToolText(await call(owner, "check_new_messages"));
    const cursors = (res.messages as { cursor: number }[]).map((m) => m.cursor);
    // 10 and 11 are older than a day; 12 is outgoing.
    expect(cursors).toEqual([13, 14, 15, 16, 17]);
    expect(res.next_cursor).toBe(17);
    expect(res.window).toBe("last 24 hours");
    expect(res.untrusted_content).toBe(true);
    lastCursor = res.next_cursor as number;
  });

  test("with a cursor, returns only newer inbound messages", async () => {
    const empty = parseToolText(
      await call(owner, "check_new_messages", { since_cursor: lastCursor }),
    );
    expect(empty.messages).toEqual([]);
    expect(empty.next_cursor).toBe(lastCursor);

    const outgoing = h.inject({ chat_id: 1, text: "my own reply", is_from_me: true });
    const inbound = h.inject({
      chat_id: 2,
      text: "Are you free?",
      sender: "+14155550102",
      sender_name: "Bob",
    });
    await waitFor(() => h.app.store.findInbound(inbound), 3000, "inbound stored");
    const res = parseToolText(
      await call(owner, "check_new_messages", { since_cursor: lastCursor }),
    );
    const messages = res.messages as { cursor: number; text: string; chat_name: string }[];
    expect(messages.map((m) => m.cursor)).toEqual([inbound]);
    expect(messages[0]).toMatchObject({ text: "Are you free?", chat_name: "Bob" });
    expect(outgoing).toBeLessThan(inbound);
    expect(res.next_cursor).toBe(inbound);
    lastCursor = inbound;
  });

  test("respects chat_id and limit, and reports has_more", async () => {
    const a = h.inject({ chat_id: 1, text: "one", sender: ALICE });
    const b = h.inject({ chat_id: 1, text: "two", sender: ALICE });
    const c = h.inject({ chat_id: 4, text: "three", sender: CAROL });
    await waitFor(() => h.app.store.findInbound(c), 3000, "inbound stored");
    const first = parseToolText(
      await call(owner, "check_new_messages", { since_cursor: lastCursor, limit: 2 }),
    );
    expect((first.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([a, b]);
    expect(first.has_more).toBe(true);
    const rest = parseToolText(
      await call(owner, "check_new_messages", { since_cursor: first.next_cursor }),
    );
    expect((rest.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([c]);
    expect(rest.has_more).toBe(false);
    const chat4 = parseToolText(
      await call(owner, "check_new_messages", { since_cursor: lastCursor, chat_id: 4 }),
    );
    expect((chat4.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([c]);
    lastCursor = c;
  });

  test("nothing is lost across a server restart", async () => {
    await owner.close();
    await h.stopHttp();
    await h.app.stop();
    // Messages arrive while the server is down.
    const x = h.inject({ chat_id: 2, text: "while you were out", sender: "+14155550102" });
    const y = h.inject({ chat_id: 4, text: "me too", sender: CAROL });
    h.app = await h.createApp();
    h.app.start();
    await waitFor(() => h.app.watcher.subscribed, 5000, "resubscribe");
    url = await h.startHttp();
    owner = await connectClient(url, await keys.sign({ email: OWNER }));
    await waitFor(() => h.app.store.findInbound(y), 3000, "replayed after restart");
    const res = parseToolText(
      await call(owner, "check_new_messages", { since_cursor: lastCursor }),
    );
    expect((res.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([x, y]);
    lastCursor = y;
  });

  test("a child crash loses nothing either", async () => {
    h.app.rpc.kill("SIGKILL");
    const z = h.inject({ chat_id: 1, text: "during the crash", sender: ALICE });
    await waitFor(() => h.app.store.findInbound(z), 5000, "replayed after child restart");
    const res = parseToolText(
      await call(owner, "check_new_messages", { since_cursor: lastCursor }),
    );
    expect((res.messages as { cursor: number }[]).map((m) => m.cursor)).toEqual([z]);
    lastCursor = z;
  });
});

describe("send_message", () => {
  test("sends to an allowlisted number, confirms via history, and audits before and after", async () => {
    const before = h.audit.records.length;
    const res = parseToolText(
      await call(owner, "send_message", { to: "+1 (415) 555-0101", text: "  On my way  " }),
    );
    expect(res).toMatchObject({ status: "sent", chat_id: 1 });
    expect(typeof res.cursor).toBe("number");
    const sent = h.readDb().messages.find((m) => m.id === res.cursor)!;
    expect(sent).toMatchObject({ text: "On my way", is_from_me: true });
    const records = h.audit.records.slice(before).filter((r) => r.tool === "send_message");
    expect(records.map((r) => [r.phase, r.status])).toEqual([
      ["before", "pending"],
      ["after", "sent"],
    ]);
    expect(records[0]).toMatchObject({
      identity: OWNER,
      text: "On my way",
      rule: "passed",
      recipient: { to: ALICE },
    });
    expect(records[1]!.request_id).toBe(records[0]!.request_id);
  });

  test("refuses a number that is not on the allowlist, even though the client approved it", async () => {
    const before = h.readDb().messages.length;
    const res = await call(owner, "send_message", { to: STRANGER, text: "hello" });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain("rule 2 (allowlist)");
    expect(h.readDb().messages.length).toBe(before);
    const refusal = h.audit.records.at(-1)!;
    expect(refusal).toMatchObject({ status: "refused", rule: "allowlist", text: "hello" });
  });

  test("the injection scenario: the stranger's text is flagged and its request is blocked", async () => {
    const res = parseToolText(await call(owner, "get_messages", { chat_id: 5 }));
    expect((res.messages as { text: string }[])[0]!.text).toBe(INJECTION_TEXT);
    expect(res.untrusted_content).toBe(true);
    const attempt = await call(owner, "send_message", { to: "+1 555 0100", text: "1234" });
    expect(attempt.isError).toBe(true);
    expect(toolText(attempt)).toContain("allowlist");
  });

  test("group chats need every member on the allowlist (or the chat id)", async () => {
    const blocked = await call(owner, "send_message", { chat_id: 3, text: "hi all" });
    expect(toolText(blocked)).toContain("1 of 2 participant(s)");
    setConfig({ send: { allowlist: [ALICE, CAROL, DANA] } });
    expect(
      parseToolText(await call(owner, "send_message", { chat_id: 3, text: "hi all" })).status,
    ).toBe("sent");
    setConfig({ send: { allowlist: [ALICE, 3] } });
    expect(
      parseToolText(await call(owner, "send_message", { chat_id: 3, text: "hi again" })).status,
    ).toBe("sent");
    setConfig({});
  });

  test("rules run in order: role, allowlist, length, rate", async () => {
    const sender = await connectClient(
      url,
      await keys.sign({ common_name: "sender.access" }, { aud: AUD_AGENT }),
    );
    try {
      // Not allowlisted and too long: the allowlist (rule 2) is reported first.
      const both = await sender.callTool({
        name: "send_message",
        arguments: { to: STRANGER, text: "x".repeat(2000) },
      });
      expect(toolText(both)).toContain("rule 2");
      const long = await sender.callTool({
        name: "send_message",
        arguments: { to: ALICE, text: "x".repeat(1001) },
      });
      expect(toolText(long)).toContain("rule 3 (length)");
      const empty = await sender.callTool({
        name: "send_message",
        arguments: { to: ALICE, text: "   " },
      });
      expect(toolText(empty)).toContain("rule 3");
    } finally {
      await sender.close();
    }
  });

  test("the rate limit stops the third send in a 2/hour window", async () => {
    h.app.store.db.exec("DELETE FROM sends");
    setConfig({ send: { rate: "2/hour" } });
    try {
      expect(
        parseToolText(await call(owner, "send_message", { to: ALICE, text: "one" })).status,
      ).toBe("sent");
      expect(
        parseToolText(await call(owner, "send_message", { to: ALICE, text: "two" })).status,
      ).toBe("sent");
      const third = await call(owner, "send_message", { to: ALICE, text: "three" });
      expect(third.isError).toBe(true);
      expect(toolText(third)).toContain("rule 4 (rate)");
      const status = parseToolText(await call(owner, "get_status"));
      expect((status.send as { remaining: number }).remaining).toBe(0);
    } finally {
      setConfig({});
      h.app.store.db.exec("DELETE FROM sends");
    }
  });

  test("needs exactly one of to or chat_id, and audits the bad calls", async () => {
    const before = h.audit.records.length;
    const neither = await call(owner, "send_message", { text: "hi" });
    expect(toolText(neither)).toContain("exactly one");
    const both = await call(owner, "send_message", { to: ALICE, chat_id: 1, text: "hi" });
    expect(toolText(both)).toContain("exactly one");
    const badChat = await call(owner, "send_message", { chat_id: -4, text: "hi" });
    expect(toolText(badChat)).toContain("positive integer");
    const records = h.audit.records.slice(before);
    expect(records).toHaveLength(3);
    expect(records.every((r) => r.tool === "send_message" && r.status === "error")).toBe(true);
  });

  test("an imsg failure while looking up the chat is audited", async () => {
    const original = h.app.chats.get.bind(h.app.chats);
    h.app.chats.get = async () => {
      throw new Error("imsg is restarting");
    };
    const before = h.audit.records.length;
    try {
      const res = await call(owner, "send_message", { chat_id: 1, text: "hello" });
      expect(res.isError).toBe(true);
    } finally {
      h.app.chats.get = original;
    }
    expect(h.audit.records.slice(before)).toEqual([
      expect.objectContaining({ tool: "send_message", status: "error", text: "hello" }),
    ]);
  });

  test("the kill switch stops a send that is waiting to retry", async () => {
    h.setBehavior({ send_mode: "not_running_once" });
    h.messagesApp.running = false;
    const originalLaunch = h.messagesApp.launch;
    h.messagesApp.launch = async () => {
      // Someone flips send.enabled off (and sends SIGHUP) while Messages is starting.
      setConfig({ send: { enabled: false } });
      h.messagesApp.running = true;
    };
    const before = h.readDb().messages.length;
    try {
      const res = await call(owner, "send_message", { to: ALICE, text: "should not go out" });
      expect(res.isError).toBe(true);
      expect(toolText(res)).toContain("turned off");
      expect(h.readDb().messages.length).toBe(before);
      expect(h.audit.records.at(-1)).toMatchObject({ phase: "after", status: "refused" });
    } finally {
      h.messagesApp.launch = originalLaunch;
      h.setBehavior({ send_mode: "ok" });
      setConfig({});
    }
  });

  test("reports handed_off_unconfirmed when the row never shows up", async () => {
    h.setBehavior({ send_mode: "no_row" });
    try {
      const res = parseToolText(
        await call(owner, "send_message", { to: CAROL, text: "are you there?" }),
      );
      expect(res).toMatchObject({ status: "handed_off_unconfirmed", cursor: null });
      expect(h.audit.records.at(-1)).toMatchObject({
        phase: "after",
        status: "handed_off_unconfirmed",
      });
    } finally {
      h.setBehavior({ send_mode: "ok" });
    }
  });

  test("opens Messages.app and retries once when it was not running", async () => {
    h.setBehavior({ send_mode: "not_running_once" });
    h.messagesApp.running = false;
    const launches = h.messagesApp.launches;
    const res = parseToolText(await call(owner, "send_message", { to: ALICE, text: "retry me" }));
    expect(res.status).toBe("sent");
    expect(h.messagesApp.launches).toBe(launches + 1);
    expect(h.readDb().messages.filter((m) => m.text === "retry me")).toHaveLength(1);
    expect(h.audit.records.some((r) => r.phase === "retry")).toBe(true);
  });

  test("never retries when the outcome is unknown", async () => {
    h.setBehavior({ send_mode: "delivery_unknown" });
    try {
      const res = await call(owner, "send_message", { to: ALICE, text: "maybe" });
      expect(res.isError).toBe(true);
      expect(toolText(res)).toContain("check get_messages before trying again");
      expect(h.audit.records.at(-1)).toMatchObject({ phase: "after", status: "failed" });
    } finally {
      h.setBehavior({ send_mode: "ok" });
    }
  });
});

describe("read scope", () => {
  test("chats outside read.scope are invisible to every read tool", async () => {
    setConfig({ read: { scope: [ALICE, 3] } });
    try {
      const chats = parseToolText(await call(owner, "list_chats"));
      expect((chats.chats as { chat_id: number }[]).map((c) => c.chat_id).sort()).toEqual([1, 3]);
      const hidden = await call(owner, "get_messages", { chat_id: 2 });
      expect(toolText(hidden)).toContain("outside the read scope");
      const news = parseToolText(await call(owner, "check_new_messages"));
      expect(
        (news.messages as { chat_id: number }[]).every((m) => [1, 3].includes(m.chat_id)),
      ).toBe(true);
      const search = parseToolText(await call(owner, "search_messages", { query: "lunch" }));
      expect(search.messages).toEqual([]);

      // New messages from out-of-scope chats are dropped before storage.
      const dropped = h.inject({ chat_id: 2, text: "secret", sender: "+14155550102" });
      const kept = h.inject({ chat_id: 1, text: "visible", sender: ALICE });
      await waitFor(() => h.app.store.findInbound(kept), 3000, "in-scope message stored");
      expect(h.app.store.findInbound(dropped)).toBeUndefined();
    } finally {
      setConfig({});
    }
  });
});
