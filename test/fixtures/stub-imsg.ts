#!/usr/bin/env bun
/**
 * A stand-in for `imsg` used by the integration tests. It speaks the same JSON-RPC 2.0
 * line protocol as `imsg rpc` and returns payloads in the exact shapes imsg emits
 * (checked against imsg 0.8.2 and 0.21.0 source: RPCPayloads.swift, OutputModels.swift).
 *
 * State lives in a JSON file (STUB_IMSG_DB) that plays the part of chat.db: tests write
 * new rows into it and the stub's watch loop picks them up, just as imsg watches chat.db.
 *
 * Environment:
 *   STUB_IMSG_DB             path of the JSON database (required for rpc)
 *   STUB_IMSG_VERSION        "0.8.2" (default) or "0.21.0" (adds messages.search, chats.get,
 *                            strict param validation, version in status)
 *   STUB_IMSG_REPLAY         path of a recorded JSONL transcript to replay instead
 *
 * Behaviour switches in the database file under "behavior":
 *   send_mode: "ok" | "no_row" | "not_running" | "not_running_once" | "timeout" | "delivery_unknown"
 *   paused_subscriptions: [ids]                        those watch streams go silent
 *   notify_before_subscribe_reply: true                backlog first, then the subscribe reply
 *   auto_reply: { "text": "pong", "delay_ms": 200 }   reply from the recipient after a send
 *   permission_denied: true                            fail every request like imsg without FDA
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface StubChat {
  id: number;
  identifier: string;
  guid: string;
  display_name?: string;
  contact_name?: string;
  service: string;
  participants: string[];
}

interface StubAttachment {
  filename: string;
  transfer_name: string;
  uti: string;
  mime_type: string;
  total_bytes: number;
  is_sticker?: boolean;
  missing?: boolean;
}

interface StubMessage {
  id: number;
  chat_id: number;
  guid: string;
  sender: string;
  sender_name?: string;
  is_from_me: boolean;
  text: string;
  created_at: string;
  attachments?: StubAttachment[];
  is_reaction?: boolean;
}

interface StubDb {
  chats: StubChat[];
  messages: StubMessage[];
  behavior?: {
    send_mode?:
      "ok" | "no_row" | "not_running" | "not_running_once" | "timeout" | "delivery_unknown";
    /** Subscriptions that silently stop emitting (to simulate a stalled watch). */
    paused_subscriptions?: number[];
    /** Write the backlog notifications before the watch.subscribe reply (imsg 0.8 can). */
    notify_before_subscribe_reply?: boolean;
    auto_reply?: { text: string; delay_ms?: number };
    permission_denied?: boolean;
  };
}

const VERSION = process.env.STUB_IMSG_VERSION ?? "0.8.2";
const MODERN = VERSION !== "0.8.2";
const DB_PATH = process.env.STUB_IMSG_DB ?? "";

const BASE_METHODS = [
  "chats.list",
  "chats.create",
  "chats.delete",
  "chats.markUnread",
  "messages.history",
  "watch.subscribe",
  "watch.unsubscribe",
  "send",
  "typing",
  "read",
  "group.rename",
];
const MODERN_METHODS = [
  ...BASE_METHODS,
  "initialize",
  "status",
  "chats.get",
  "messages.search",
  "messages.after",
];
const METHODS = MODERN ? MODERN_METHODS : BASE_METHODS;

const STRICT_KEYS: Record<string, string[]> = {
  "chats.list": ["limit", "unread_only", "unreadOnly"],
  "chats.get": ["chat_id"],
  "messages.history": [
    "chat_id",
    "limit",
    "participants",
    "start",
    "end",
    "attachments",
    "convert_attachments",
  ],
  "messages.search": ["query", "match", "limit"],
  "watch.subscribe": [
    "chat_id",
    "since_rowid",
    "participants",
    "start",
    "end",
    "attachments",
    "convert_attachments",
    "include_reactions",
    "debounce_ms",
    "debounceMs",
    "buffer_limit",
    "bufferLimit",
  ],
  "watch.unsubscribe": ["subscription"],
  send: [
    "to",
    "text",
    "file",
    "service",
    "region",
    "allow_sms_fallback",
    "chat_id",
    "chat_identifier",
    "chat_guid",
    "transport",
  ],
};

const PERMISSION_DATA =
  "authorization denied (code: 23)\n\n⚠️  Permission Error: Cannot access Messages database\n\n" +
  "The Messages database at /Users/me/Library/Messages/chat.db requires Full Disk Access permission.";

// ---------------------------------------------------------------------------

function loadDb(): StubDb {
  if (!DB_PATH || !existsSync(DB_PATH)) return { chats: [], messages: [] };
  return JSON.parse(readFileSync(DB_PATH, "utf8")) as StubDb;
}

function saveDb(db: StubDb): void {
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH);
}

function write(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function isGroup(chat: StubChat): boolean {
  return chat.guid.includes(";+;") || chat.identifier.includes(";+;");
}

function chatPayload(db: StubDb, chat: StubChat): Record<string, unknown> {
  const last = db.messages
    .filter((m) => m.chat_id === chat.id)
    .reduce((acc, m) => (m.created_at > acc ? m.created_at : acc), "1970-01-01T00:00:00.000Z");
  const payload: Record<string, unknown> = {
    id: chat.id,
    identifier: chat.identifier,
    guid: chat.guid,
    name: chat.display_name || chat.contact_name || chat.identifier,
    service: chat.service,
    last_message_at: last,
    participants: chat.participants,
    is_group: isGroup(chat),
  };
  if (chat.contact_name && !isGroup(chat)) payload.contact_name = chat.contact_name;
  if (MODERN && chat.display_name) payload.display_name = chat.display_name;
  return payload;
}

function messagePayload(
  db: StubDb,
  m: StubMessage,
  withAttachments: boolean,
): Record<string, unknown> {
  const chat = db.chats.find((c) => c.id === m.chat_id);
  const payload: Record<string, unknown> = {
    id: m.id,
    chat_id: m.chat_id,
    guid: m.guid,
    sender: m.sender,
    is_from_me: m.is_from_me,
    text: m.text,
    created_at: m.created_at,
    attachments: withAttachments
      ? (m.attachments ?? []).map((a) => ({
          filename: a.filename,
          transfer_name: a.transfer_name,
          uti: a.uti,
          mime_type: a.mime_type,
          total_bytes: a.total_bytes,
          is_sticker: a.is_sticker ?? false,
          original_path: `/Users/me/Library/Messages/Attachments/${a.filename}`,
          missing: a.missing ?? false,
        }))
      : [],
    reactions: [],
    chat_identifier: chat?.identifier ?? "",
    chat_guid: chat?.guid ?? "",
    chat_name: chat?.display_name ?? "",
    participants: chat?.participants ?? [],
    is_group: chat ? isGroup(chat) : false,
  };
  if (m.sender_name) payload.sender_name = m.sender_name;
  if (m.is_reaction) {
    payload.is_reaction = true;
    payload.reaction_type = "like";
  }
  return payload;
}

function intParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (MODERN && typeof v !== "number")
    throw new RpcError(-32602, "Invalid params", `${key} must be an integer`);
  const n = Number(v);
  if (!Number.isFinite(n))
    throw new RpcError(-32602, "Invalid params", `${key} must be an integer`);
  return n;
}

function checkKeys(method: string, params: Record<string, unknown>): void {
  if (!MODERN) return;
  const allowed = STRICT_KEYS[method];
  if (!allowed) return;
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key))
      throw new RpcError(-32602, "Invalid params", `unknown parameter: ${key}`);
  }
}

// ---------------------------------------------------------------------------

interface Subscription {
  id: number;
  cursor: number;
  chatId?: number;
  attachments: boolean;
}

const subscriptions = new Map<number, Subscription>();
let nextSub = 1;

function maxRowid(db: StubDb): number {
  return db.messages.reduce((acc, m) => Math.max(acc, m.id), 0);
}

function pollSubscriptions(): void {
  if (subscriptions.size === 0) return;
  let db: StubDb;
  try {
    db = loadDb();
  } catch {
    return; // Mid-write; try again on the next tick.
  }
  const sorted = [...db.messages].sort((a, b) => a.id - b.id);
  const paused = new Set(db.behavior?.paused_subscriptions ?? []);
  for (const sub of subscriptions.values()) {
    if (paused.has(sub.id)) continue;
    for (const m of sorted) {
      if (m.id <= sub.cursor) continue;
      if (sub.chatId !== undefined && m.chat_id !== sub.chatId) continue;
      sub.cursor = m.id;
      if (m.is_reaction) continue;
      write({
        jsonrpc: "2.0",
        method: "message",
        params: { subscription: sub.id, message: messagePayload(db, m, sub.attachments) },
      });
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function directChatFor(db: StubDb, to: string): StubChat {
  let chat = db.chats.find((c) => !isGroup(c) && c.identifier === to);
  if (!chat) {
    const id = db.chats.reduce((acc, c) => Math.max(acc, c.id), 0) + 1;
    chat = {
      id,
      identifier: to,
      guid: `iMessage;-;${to}`,
      service: "iMessage",
      participants: [to],
    };
    db.chats.push(chat);
  }
  return chat;
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  const db = loadDb();
  if (db.behavior?.permission_denied) {
    throw new RpcError(-32603, "Internal error", PERMISSION_DATA);
  }
  checkKeys(method, params);
  switch (method) {
    case "chats.list": {
      const limit = intParam(params, "limit") ?? 20;
      const chats = db.chats
        .map((c) => chatPayload(db, c))
        .sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)))
        .slice(0, Math.max(1, limit));
      return { chats };
    }
    case "chats.get": {
      if (!MODERN) throw new RpcError(-32601, "Method not found");
      const id = intParam(params, "chat_id");
      const chat = db.chats.find((c) => c.id === id);
      if (!chat) throw new RpcError(-32602, "Invalid params", `Chat not found: ${id}`);
      const { last_message_at: _ignored, ...rest } = chatPayload(db, chat);
      return rest;
    }
    case "messages.history": {
      const chatId = intParam(params, "chat_id");
      if (chatId === undefined) throw new RpcError(-32602, "Invalid params", "chat_id is required");
      const limit = intParam(params, "limit") ?? 50;
      const start = typeof params.start === "string" ? Date.parse(params.start) : undefined;
      const end = typeof params.end === "string" ? Date.parse(params.end) : undefined;
      const messages = db.messages
        .filter((m) => m.chat_id === chatId && !m.is_reaction)
        .filter((m) => start === undefined || Date.parse(m.created_at) >= start)
        .filter((m) => end === undefined || Date.parse(m.created_at) < end)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
        .slice(0, Math.max(1, limit))
        .map((m) => messagePayload(db, m, params.attachments === true));
      return { messages };
    }
    case "messages.search": {
      if (!MODERN) throw new RpcError(-32601, "Method not found");
      const query = String(params.query ?? "").toLowerCase();
      if (!query) throw new RpcError(-32602, "Invalid params", "query is required");
      const limit = Math.min(100, intParam(params, "limit") ?? 50);
      const messages = db.messages
        .filter((m) => !m.is_reaction && m.text.toLowerCase().includes(query))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, limit)
        .map((m) => ({ ...messagePayload(db, m, false), attachments: [] }));
      return { messages };
    }
    case "watch.subscribe": {
      const since = intParam(params, "since_rowid");
      const id = nextSub++;
      const sub: Subscription = {
        id,
        cursor: since !== undefined && since > 0 ? since : maxRowid(db),
        chatId: intParam(params, "chat_id"),
        attachments: params.attachments === true,
      };
      subscriptions.set(id, sub);
      if (db.behavior?.notify_before_subscribe_reply) {
        for (const m of [...db.messages].sort((a, b) => a.id - b.id)) {
          if (m.id <= sub.cursor || m.is_reaction) continue;
          sub.cursor = m.id;
          write({
            jsonrpc: "2.0",
            method: "message",
            params: { subscription: id, message: messagePayload(db, m, sub.attachments) },
          });
        }
      }
      return MODERN ? { subscription: id, buffer_limit: 256 } : { subscription: id };
    }
    case "watch.unsubscribe": {
      const id = intParam(params, "subscription");
      if (id !== undefined) subscriptions.delete(id);
      return { ok: true };
    }
    case "send": {
      const text = typeof params.text === "string" ? params.text : "";
      const to = typeof params.to === "string" ? params.to : "";
      const chatId = intParam(params, "chat_id");
      if (!text) throw new RpcError(-32602, "Invalid params", "text or file is required");
      if (to && chatId !== undefined)
        throw new RpcError(-32602, "Invalid params", "use to or chat_*; not both");
      const mode = db.behavior?.send_mode ?? "ok";
      if (mode === "timeout") return new Promise(() => undefined);
      if (mode === "not_running" || mode === "not_running_once") {
        if (mode === "not_running_once") {
          db.behavior = { ...db.behavior, send_mode: "ok" };
          saveDb(db);
        }
        throw new RpcError(
          -32603,
          "Internal error",
          "Messages got an error: Application isn't running. (-600)",
        );
      }
      if (mode === "delivery_unknown") {
        throw new RpcError(-32001, "Delivery outcome unknown", {
          retry_safe: false,
          disposition: "may_have_completed",
          transport: "applescript",
          operation: "send",
          detail: "AppleScript timed out",
        });
      }
      let chat: StubChat | undefined;
      if (chatId !== undefined) {
        chat = db.chats.find((c) => c.id === chatId);
        if (!chat) throw new RpcError(-32602, "Invalid params", `unknown chat_id ${chatId}`);
      } else {
        chat = directChatFor(db, to);
      }
      const rowid = maxRowid(db) + 1;
      const guid = `STUB-${rowid}`;
      if (mode === "ok") {
        db.messages.push({
          id: rowid,
          chat_id: chat.id,
          guid,
          sender: "",
          is_from_me: true,
          text,
          created_at: nowIso(),
        });
      }
      saveDb(db);
      const reply = db.behavior?.auto_reply;
      if (reply) {
        const replier = chat.participants[0] ?? to;
        setTimeout(() => {
          const fresh = loadDb();
          fresh.messages.push({
            id: maxRowid(fresh) + 1,
            chat_id: chat!.id,
            guid: `STUB-REPLY-${Date.now()}`,
            sender: replier,
            is_from_me: false,
            text: reply.text,
            created_at: nowIso(),
          });
          saveDb(fresh);
        }, reply.delay_ms ?? 200);
      }
      return mode === "ok"
        ? { ok: true, transport: "applescript", id: rowid, guid }
        : { ok: true, transport: "applescript" };
    }
    default:
      throw new RpcError(-32601, "Method not found");
  }
}

// ---------------------------------------------------------------------------

function runReplay(path: string): void {
  // Each transcript line: {"method": "...", "result": {...}} or {"method": "...", "error": {...}}
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("//"))
    .map(
      (l) =>
        JSON.parse(l) as {
          method: string;
          result?: unknown;
          error?: unknown;
          notifications?: unknown[];
        },
    );
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const req = JSON.parse(line) as { id?: number; method: string };
    const idx = entries.findIndex((e) => e.method === req.method);
    if (idx < 0) {
      write({
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    const [entry] = entries.splice(idx, 1);
    if (req.id === undefined) return;
    if (entry!.error) write({ jsonrpc: "2.0", id: req.id, error: entry!.error });
    else write({ jsonrpc: "2.0", id: req.id, result: entry!.result });
    for (const n of entry!.notifications ?? []) write(n);
  });
  rl.on("close", () => process.exit(0));
}

function runRpc(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const id = req.id;
    try {
      const result = await handle(String(req.method), req.params ?? {});
      if (id !== undefined) write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      if (id === undefined) return;
      if (err instanceof RpcError) {
        const error: Record<string, unknown> = { code: err.code, message: err.message };
        if (err.data !== undefined) error.data = err.data;
        write({ jsonrpc: "2.0", id, error });
      } else {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "Internal error", data: String(err) },
        });
      }
    }
  });
  rl.on("close", () => process.exit(0));
  setInterval(pollSubscriptions, 40);
  process.stderr.write("stub imsg rpc ready\n");
}

const [command, ...rest] = process.argv.slice(2);
if (command === "--version") {
  process.stdout.write(`${VERSION}\n`);
} else if (command === "status") {
  const status: Record<string, unknown> = {
    read_receipts: false,
    selectors: {},
    sip: "enabled",
    basic_features: true,
    rpc_methods: METHODS,
    message:
      "System Integrity Protection (SIP) is enabled.\nAdvanced IMCore features are intentionally disabled.",
    typing_indicators: false,
    v2_ready: false,
    bridge_version: 0,
    advanced_features: false,
  };
  if (MODERN) status.version = VERSION;
  if (process.env.STUB_IMSG_STATUS_METHODS) {
    status.rpc_methods = process.env.STUB_IMSG_STATUS_METHODS.split(",").filter(Boolean);
  }
  process.stdout.write(`${JSON.stringify(status)}\n`);
  void rest;
} else if (command === "rpc") {
  if (process.env.STUB_IMSG_REPLAY) runReplay(process.env.STUB_IMSG_REPLAY);
  else runRpc();
} else {
  process.stderr.write(`stub imsg: unsupported command ${command}\n`);
  process.exit(64);
}
