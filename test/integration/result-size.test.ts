/**
 * Claude cuts off tool results above about 150,000 characters (25,000 tokens in Claude
 * Code). The server trims pages to read.max_result_chars instead, and paging with the
 * cursors must still return every message exactly once.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CAROL } from "../helpers/fixtures";
import {
  accessKeys,
  connectClient,
  Harness,
  OWNER,
  parseToolText,
  toolText,
  waitFor,
} from "../helpers/harness";

const BUDGET = 10_000;
const LONG = 3_000;

let h: Harness;
let client: Client;
const injected: number[] = [];

beforeAll(async () => {
  const keys = await accessKeys();
  h = await new Harness({
    keySource: keys.keySource,
    config: { read: { max_result_chars: BUDGET } },
  }).start();
  client = await connectClient(await h.startHttp(), await keys.sign({ email: OWNER }));
  await waitFor(() => h.app.store.getCursor() === 17, 3000, "backfill");
  for (let i = 0; i < 30; i++) {
    injected.push(h.inject({ chat_id: 4, text: `msg-${i} ${"y".repeat(LONG)}`, sender: CAROL }));
  }
  await waitFor(() => h.app.store.findInbound(injected.at(-1)!), 5000, "all stored");
});

afterAll(async () => {
  await client?.close();
  await h?.stop();
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const raw = toolText(res);
  expect(raw.length).toBeLessThanOrEqual(BUDGET);
  return parseToolText(res);
}

describe("results stay under read.max_result_chars", () => {
  test("get_messages trims the oldest messages and pages back to every one of them", async () => {
    const seen: number[] = [];
    let before: number | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await call("get_messages", { chat_id: 4, limit: 200, before_cursor: before });
      const cursors = (res.messages as { cursor: number }[]).map((m) => m.cursor);
      seen.unshift(...cursors);
      if (res.prev_cursor === null) break;
      expect(res.size_note).toBeDefined();
      before = res.prev_cursor as number;
    }
    expect(seen).toEqual([15, ...injected]);
  });

  test("check_new_messages keeps the cursor continuous across trimmed pages", async () => {
    const seen: number[] = [];
    let cursor = 17;
    for (let page = 0; page < 50; page++) {
      const res = await call("check_new_messages", { since_cursor: cursor, limit: 200 });
      seen.push(...(res.messages as { cursor: number }[]).map((m) => m.cursor));
      cursor = res.next_cursor as number;
      if (!res.has_more) break;
    }
    expect(seen).toEqual(injected);
    expect(cursor).toBe(injected.at(-1)!);
  });

  test("check_new_messages without a cursor keeps the newest and points past them", async () => {
    const res = await call("check_new_messages", { limit: 200 });
    const cursors = (res.messages as { cursor: number }[]).map((m) => m.cursor);
    expect(cursors.at(-1)).toBe(injected.at(-1));
    expect(res.next_cursor).toBe(injected.at(-1));
    expect(res.has_more).toBe(true);
  });

  test("search_messages keeps the newest matches", async () => {
    const res = await call("search_messages", { query: "msg-", limit: 50 });
    const cursors = (res.messages as { cursor: number }[]).map((m) => m.cursor);
    expect(cursors[0]).toBe(injected.at(-1));
    expect(res.total_matches).toBe(30);
    expect(res.size_note).toBeDefined();
  });

  test("the default budget fits Claude's limits", async () => {
    const { buildConfig } = await import("../../src/config/schema");
    const cfg = buildConfig({});
    // claude.ai and Desktop accept about 150,000 characters; Claude Code 25,000 tokens.
    expect(cfg.read.max_result_chars).toBeLessThanOrEqual(100_000);
    expect(cfg.read.max_result_chars).toBeGreaterThanOrEqual(cfg.read.max_text_chars * 5);
  });
});
