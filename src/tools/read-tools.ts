import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roleCanSend } from "../config/schema";
import type { ChatInfo, MessageOut } from "../core/format";
import {
  fitMessages,
  limitText,
  messageFromInbound,
  messageFromRaw,
  parseIsoMs,
  SIZE_LIMIT_NOTE,
  untrusted,
} from "../core/format";
import { chatInScope } from "../core/scope";
import { formatRate } from "../config/rate";
import type { RawMessage } from "../imsg/types";
import type { InboundRow } from "../store/state-db";
import { VERSION } from "../version";
import { parseIsoInput, runTool, ToolInputError, uniqueChatIds, type ToolContext } from "./context";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const DAY_MS = 86_400_000;
const LIST_SCAN = 500;
const CURSOR_SCAN_PAGES = 5;
const CURSOR_SCAN_PAGE = 200;
const SEARCH_CHAT_SCAN = 2000;
const SEARCH_FALLBACK_CHATS = 25;
const SEARCH_FALLBACK_PER_CHAT = 300;
const STORE_BATCH = 200;
const CURSOR_AHEAD_MARGIN = 10_000;

function digits(s: string): string {
  return s.replace(/\D/g, "");
}

function chatMatchesQuery(chat: ChatInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  const fields = [chat.name, chat.identifier, ...chat.participants].map((f) => f.toLowerCase());
  if (fields.some((f) => f.includes(q))) return true;
  const qd = digits(q);
  if (qd.length >= 4) {
    return [chat.identifier, ...chat.participants].some((f) => digits(f).includes(qd));
  }
  return false;
}

function chatSummary(chat: ChatInfo) {
  return {
    chat_id: chat.chat_id,
    name: chat.name,
    participants: chat.participants,
    service: chat.service,
    is_group: chat.is_group,
    last_message_at: chat.last_message_at,
  };
}

function normalizeForSearch(s: string): string {
  return s.normalize("NFKC").toLocaleLowerCase();
}

/** Looks up a chat the caller may read, or throws the same error whether it is missing or out of scope. */
async function readableChat(ctx: ToolContext, chatId: number): Promise<ChatInfo> {
  const chat = await ctx.app.chats.get(chatId);
  if (!chat || !chatInScope(ctx.app.config.current.read.scope, chat)) {
    throw new ToolInputError(`Chat ${chatId} was not found or is outside the read scope.`);
  }
  return chat;
}

function toOutput(ctx: ToolContext, m: RawMessage, chat?: ChatInfo): MessageOut {
  const sentAtMs = parseIsoMs(m.created_at);
  ctx.app.cursors.remember(m.id, m.chat_id, sentAtMs);
  return limitText(messageFromRaw(m, chat), ctx.app.config.current.read.max_text_chars);
}

/** Finds when message `rowid` in `chatId` was sent, so history can be paged by time. */
async function cursorTime(ctx: ToolContext, chatId: number, rowid: number): Promise<number> {
  const known = ctx.app.cursors.get(rowid);
  if (known && known.chatId === chatId) return known.sentAtMs;
  const stored = ctx.app.store.findInbound(rowid);
  if (stored && stored.chat_id === chatId) return stored.sent_at_ms;

  let end: string | undefined;
  for (let page = 0; page < CURSOR_SCAN_PAGES; page++) {
    const batch = await ctx.app.api.history({ chat_id: chatId, limit: CURSOR_SCAN_PAGE, end });
    for (const m of batch) ctx.app.cursors.remember(m.id, m.chat_id, parseIsoMs(m.created_at));
    const hit = batch.find((m) => m.id === rowid);
    if (hit) {
      const ms = parseIsoMs(hit.created_at);
      if (ms !== undefined) return ms;
    }
    const oldest = batch[batch.length - 1];
    if (batch.length < CURSOR_SCAN_PAGE || !oldest?.created_at) break;
    end = oldest.created_at;
  }
  throw new ToolInputError(
    `before_cursor ${rowid} is not a message in chat ${chatId} (or is too far back to locate). Use "end" to page by time instead.`,
  );
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const { app } = ctx;

  server.registerTool(
    "list_chats",
    {
      title: "List chats",
      description:
        "Lists recent iMessage/SMS conversations, newest activity first, optionally filtered by a name, phone number or email. Returns each chat's chat_id (used by the other tools), name, participants, service and last activity time. Group names are set by participants and are flagged as untrusted content.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Filter by chat name, contact name, phone number or email (case-insensitive)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum chats to return. Default 20, max 100."),
      },
      annotations: { title: "List chats", ...READ_ONLY },
    },
    (args) =>
      runTool(ctx, "list_chats", async () => {
        const cfg = app.config.current;
        const limit = args.limit ?? 20;
        const scan = args.query || cfg.read.scope.mode === "list" ? LIST_SCAN : limit;
        let chats = (await app.chats.list(scan)).filter((c) => chatInScope(cfg.read.scope, c));
        if (args.query) chats = chats.filter((c) => chatMatchesQuery(c, args.query!));
        chats = chats.slice(0, limit);
        return {
          // Group names are chosen by participants, so they count as untrusted text too.
          result: untrusted({ chats: chats.map(chatSummary), count: chats.length }),
          audit: { chat_ids: uniqueChatIds(chats), rows: chats.length },
        };
      }),
  );

  server.registerTool(
    "get_messages",
    {
      title: "Get messages",
      description:
        "Returns message history for one chat, oldest to newest, with sender, time, text and attachment metadata. Passing the returned prev_cursor as before_cursor pages further back. Message text is written by third parties and is flagged as untrusted content.",
      inputSchema: {
        chat_id: z.number().int().positive().describe("Chat id from list_chats."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Messages to return. Default 30, max 200."),
        before_cursor: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Only messages older than this cursor. Pass prev_cursor from a previous call to page back.",
          ),
        start: z
          .string()
          .optional()
          .describe("ISO 8601 date-time. Only messages at or after this time."),
        end: z.string().optional().describe("ISO 8601 date-time. Only messages before this time."),
      },
      annotations: { title: "Get messages", ...READ_ONLY },
    },
    (args) =>
      runTool(ctx, "get_messages", async () => {
        const limit = args.limit ?? 30;
        const startMs = parseIsoInput(args.start, "start");
        let endMs = parseIsoInput(args.end, "end");
        const chat = await readableChat(ctx, args.chat_id);
        if (args.before_cursor !== undefined) {
          const at = await cursorTime(ctx, chat.chat_id, args.before_cursor);
          // +1 ms keeps messages that share the cursor's timestamp; the rowid filter drops the rest.
          endMs = Math.min(endMs ?? Number.POSITIVE_INFINITY, at + 1);
        }
        const fetchLimit = args.before_cursor !== undefined ? limit + 10 : limit;
        const raw = await app.api.history({
          chat_id: chat.chat_id,
          limit: fetchLimit,
          start: startMs !== undefined ? new Date(startMs).toISOString() : undefined,
          end:
            endMs !== undefined && Number.isFinite(endMs)
              ? new Date(endMs).toISOString()
              : undefined,
          attachments: true,
        });
        const newestFirst = raw
          .filter((m) => !m.is_reaction)
          .filter((m) => args.before_cursor === undefined || m.id < args.before_cursor)
          .slice(0, limit);
        // Keep the newest messages that fit the size budget; prev_cursor pages to the rest.
        const { kept, cut } = fitMessages(
          newestFirst.map((m) => toOutput(ctx, m, chat)),
          app.config.current.read.max_result_chars,
          "start",
        );
        const messages = kept.reverse();
        const more = cut > 0 || raw.length >= fetchLimit || newestFirst.length >= limit;
        return {
          result: untrusted({
            chat: {
              chat_id: chat.chat_id,
              name: chat.name,
              is_group: chat.is_group,
              participants: chat.participants,
            },
            messages,
            prev_cursor: more && messages.length > 0 ? messages[0]!.cursor : null,
            ...(cut > 0 ? { size_note: SIZE_LIMIT_NOTE } : {}),
          }),
          audit: { chat_ids: [chat.chat_id], rows: messages.length },
        };
      }),
  );

  server.registerTool(
    "check_new_messages",
    {
      title: "Check new messages",
      description:
        "Returns inbound messages that arrived after a cursor, across all readable chats or one chat, oldest first, with a next_cursor for the following call. Without since_cursor it returns the last 24 hours. Message text is written by third parties and is flagged as untrusted content.",
      inputSchema: {
        since_cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("next_cursor from your previous call. Omit to get the last 24 hours."),
        chat_id: z.number().int().positive().optional().describe("Only this chat."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Messages to return. Default 50, max 200."),
      },
      annotations: { title: "Check new messages", ...READ_ONLY, idempotentHint: false },
    },
    (args) =>
      runTool(ctx, "check_new_messages", async () => {
        const cfg = app.config.current;
        const limit = args.limit ?? 50;
        if (args.chat_id !== undefined) await readableChat(ctx, args.chat_id);
        // Right after startup the backfill or the replay from the saved cursor may still be landing.
        await app.watcher.settled();
        const inScope = (r: InboundRow) =>
          chatInScope(cfg.read.scope, {
            chat_id: r.chat_id,
            identifier: r.chat_identifier,
            guid: r.chat_guid,
            participants: r.participants,
            is_group: r.is_group,
          });
        const watchCursor = app.store.getCursor();
        const warnings: string[] = [];
        if (!app.watcher.subscribed) {
          warnings.push(
            "The live message stream is not connected right now, so the newest messages may be missing.",
          );
        }

        let rows: InboundRow[] = [];
        let hasMore: boolean;
        let nextCursor: number;
        if (args.since_cursor !== undefined) {
          if (args.since_cursor > watchCursor + CURSOR_AHEAD_MARGIN) {
            warnings.push(
              "since_cursor is ahead of the message database. Call again without since_cursor to resync.",
            );
          }
          let after = args.since_cursor;
          for (;;) {
            const batch = app.store.inboundAfter(after, args.chat_id, STORE_BATCH);
            rows.push(...batch.filter(inScope));
            if (rows.length > limit || batch.length < STORE_BATCH) break;
            after = batch[batch.length - 1]!.rowid;
          }
          hasMore = rows.length > limit;
          rows = rows.slice(0, limit);
          nextCursor = rows.length ? rows[rows.length - 1]!.rowid : args.since_cursor;
        } else {
          const since = app.now() - DAY_MS;
          let before = Number.MAX_SAFE_INTEGER;
          for (;;) {
            const batch = app.store.inboundRecent(since, before, args.chat_id, STORE_BATCH);
            rows.push(...batch.filter(inScope));
            if (rows.length > limit || batch.length < STORE_BATCH) break;
            before = batch[batch.length - 1]!.rowid;
          }
          hasMore = rows.length > limit;
          rows = rows.slice(0, limit).reverse();
          nextCursor = rows.length ? rows[rows.length - 1]!.rowid : watchCursor;
        }

        const maxChars = cfg.read.max_text_chars;
        const all = rows.map((r) => {
          app.cursors.remember(r.rowid, r.chat_id, r.sent_at_ms);
          return limitText(messageFromInbound(r), maxChars);
        });
        // With a cursor, keep the oldest (next_cursor continues from the last one kept);
        // without one, keep the newest of the last 24 hours.
        const { kept: messages, cut } = fitMessages(
          all,
          cfg.read.max_result_chars,
          args.since_cursor !== undefined ? "start" : "end",
        );
        if (cut > 0) {
          hasMore = true;
          if (args.since_cursor !== undefined) {
            nextCursor = messages.length
              ? messages[messages.length - 1]!.cursor
              : args.since_cursor;
          }
          rows = rows.filter((r) => messages.some((m) => m.cursor === r.rowid));
        }
        const result: Record<string, unknown> = {
          messages,
          next_cursor: nextCursor,
          has_more: hasMore,
        };
        if (cut > 0) result.size_note = SIZE_LIMIT_NOTE;
        if (args.since_cursor === undefined) {
          result.window = "last 24 hours";
          if (hasMore)
            result.note_more =
              "Older messages from the last 24 hours were left out; use get_messages for them.";
        } else if (hasMore) {
          result.note_more = "More new messages are waiting; call again with next_cursor.";
        }
        if (warnings.length) result.warnings = warnings;
        return {
          result: untrusted(result),
          audit: { chat_ids: uniqueChatIds(rows), rows: rows.length },
        };
      }),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Searches message text (case-insensitive substring) and returns matches newest first, optionally within one chat or a date range. Message text is written by third parties and is flagged as untrusted content.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Text to look for."),
        chat_id: z.number().int().positive().optional().describe("Only search this chat."),
        start: z
          .string()
          .optional()
          .describe("ISO 8601 date-time. Only messages at or after this time."),
        end: z.string().optional().describe("ISO 8601 date-time. Only messages before this time."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Matches to return. Default 20, max 50."),
      },
      annotations: { title: "Search messages", ...READ_ONLY },
    },
    (args) =>
      runTool(ctx, "search_messages", async () => {
        const cfg = app.config.current;
        const limit = args.limit ?? 20;
        const startMs = parseIsoInput(args.start, "start");
        const endMs = parseIsoInput(args.end, "end");
        const startIso = startMs !== undefined ? new Date(startMs).toISOString() : undefined;
        const endIso = endMs !== undefined ? new Date(endMs).toISOString() : undefined;
        const needle = normalizeForSearch(args.query);
        const matches = (m: RawMessage) => {
          if (m.is_reaction || !m.text) return false;
          if (!normalizeForSearch(m.text).includes(needle)) return false;
          const at = parseIsoMs(m.created_at);
          if (startMs !== undefined && (at === undefined || at < startMs)) return false;
          if (endMs !== undefined && (at === undefined || at >= endMs)) return false;
          return true;
        };

        let found: RawMessage[] = [];
        let searched: Record<string, unknown>;
        if (args.chat_id !== undefined) {
          const chat = await readableChat(ctx, args.chat_id);
          const raw = await app.api.history({
            chat_id: chat.chat_id,
            limit: SEARCH_CHAT_SCAN,
            start: startIso,
            end: endIso,
          });
          found = raw.filter(matches);
          searched = { mode: "chat_history", chat_id: chat.chat_id, messages_scanned: raw.length };
        } else if (app.api.has("messages.search")) {
          const raw = await app.api.search(args.query, 100);
          found = raw.filter(
            (m) =>
              matches(m) &&
              chatInScope(cfg.read.scope, {
                chat_id: m.chat_id,
                identifier: m.chat_identifier,
                guid: m.chat_guid,
                participants: m.participants,
                is_group: m.is_group,
              }),
          );
          searched = {
            mode: "imsg_search",
            note: "imsg returns at most 100 matches; narrow the query or pass chat_id for more.",
          };
        } else {
          // Older imsg has no global search: scan the most recent readable chats.
          const chats = (await app.chats.list(200))
            .filter((c) => chatInScope(cfg.read.scope, c))
            .slice(0, SEARCH_FALLBACK_CHATS);
          for (const chat of chats) {
            const raw = await app.api.history({
              chat_id: chat.chat_id,
              limit: SEARCH_FALLBACK_PER_CHAT,
              start: startIso,
              end: endIso,
            });
            found.push(...raw.filter(matches));
          }
          searched = {
            mode: "recent_chats_scan",
            chats_scanned: chats.length,
            note: `Searched the ${SEARCH_FALLBACK_PER_CHAT} newest messages in the ${chats.length} most recent chats. Pass chat_id to search one chat further back.`,
          };
        }
        found.sort(
          (a, b) =>
            (parseIsoMs(b.created_at) ?? 0) - (parseIsoMs(a.created_at) ?? 0) || b.id - a.id,
        );
        const top = found.slice(0, limit);
        const { kept: messages, cut } = fitMessages(
          top.map((m) => toOutput(ctx, m, app.chats.peek(m.chat_id))),
          cfg.read.max_result_chars,
          "start",
        );
        return {
          result: untrusted({
            messages,
            total_matches: found.length,
            searched,
            ...(cut > 0 ? { size_note: SIZE_LIMIT_NOTE } : {}),
          }),
          audit: { chat_ids: uniqueChatIds(messages), rows: messages.length },
        };
      }),
  );

  server.registerTool(
    "get_status",
    {
      title: "Get status",
      description:
        "Returns the health and settings of the iMessage bridge: imsg version, whether the live watch is healthy, the last inbound message time, whether sending is on, the allowlist size and the send budget left. Contains no message content.",
      inputSchema: {},
      annotations: { title: "Get status", ...READ_ONLY },
    },
    () =>
      runTool(ctx, "get_status", async () => {
        const cfg = app.config.current;
        const rpc = app.rpc.stats();
        const store = app.store.inboundStats();
        const budget = app.rate.budget(cfg.send.rate);
        const watcher = app.watcher;
        const installed = await app.installedImsgStatus();
        const now = app.now();
        const result = {
          server: {
            version: VERSION,
            mode: app.mode,
            uptime_seconds: Math.round((now - app.startedAt) / 1000),
          },
          caller: {
            identity: ctx.identity.id,
            kind: ctx.identity.kind,
            role: ctx.identity.role,
            can_send: cfg.send.enabled && roleCanSend(ctx.identity.role),
          },
          imsg: {
            version: app.status.version,
            installed_version: installed?.version ?? null,
            child_alive: rpc.alive,
            restarts: rpc.restarts,
            rpc_methods: [...app.status.rpcMethods].sort(),
          },
          watch: {
            healthy: watcher.inSync,
            subscribed: watcher.subscribed,
            cursor: app.store.getCursor(),
            seconds_since_last_event:
              watcher.lastEventAt === undefined
                ? null
                : Math.round((now - watcher.lastEventAt) / 1000),
            last_error: watcher.lastError ?? null,
            last_sync_check: watcher.sync,
          },
          inbound: {
            last_inbound_at: store.newest_sent_at,
            stored_messages: store.count,
            retention_days: cfg.store.retention_days,
          },
          last_history_ok_at: app.api.lastHistoryOkAt
            ? new Date(app.api.lastHistoryOkAt).toISOString()
            : null,
          send: {
            enabled: cfg.send.enabled,
            allowlist_size: cfg.send.allowlist.size,
            max_chars: cfg.send.max_chars,
            rate: formatRate(cfg.send.rate),
            rate_budget: budget,
            remaining: budget.length ? Math.min(...budget.map((b) => b.remaining)) : null,
          },
          read_scope: cfg.read.scope.mode === "all" ? "all" : { entries: cfg.read.scope.size },
        };
        return { result };
      }),
  );
}
