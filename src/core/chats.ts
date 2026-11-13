import { chatInfoFromRaw, type ChatInfo } from "./format";
import type { ImsgApi } from "./imsg-api";

const FRESH_MS = 5 * 60_000;
const FULL_REFRESH_MIN_INTERVAL_MS = 60_000;
const FULL_REFRESH_LIMIT = 1000;

/**
 * Cache of chat metadata (name, participants, service) keyed by chat id. Used for
 * read-scope checks, allowlist checks on group sends, and naming chats in results.
 */
export class ChatDirectory {
  private readonly cache = new Map<number, { info: ChatInfo; at: number }>();
  private lastFullRefresh = 0;

  constructor(
    private readonly api: ImsgApi,
    private readonly now: () => number = Date.now,
  ) {}

  remember(info: ChatInfo): void {
    this.cache.set(info.chat_id, { info, at: this.now() });
  }

  peek(chatId: number): ChatInfo | undefined {
    return this.cache.get(chatId)?.info;
  }

  /** Most recent chats first, straight from imsg. */
  async list(limit: number): Promise<ChatInfo[]> {
    const raw = await this.api.chatsList(limit);
    const chats = raw.map(chatInfoFromRaw);
    for (const chat of chats) this.remember(chat);
    if (limit >= FULL_REFRESH_LIMIT) this.lastFullRefresh = this.now();
    return chats;
  }

  /**
   * One chat by id. Uses the cache when fresh, then `chats.get` (imsg 0.16+), then a
   * wide `chats.list` at most once a minute. Undefined when the chat does not exist.
   * `fresh` skips the cache, which group sends use so membership is current.
   */
  async get(chatId: number, opts: { fresh?: boolean } = {}): Promise<ChatInfo | undefined> {
    const cached = this.cache.get(chatId);
    if (!opts.fresh && cached && this.now() - cached.at < FRESH_MS) return cached.info;

    if (this.api.has("chats.get")) {
      const raw = await this.api.chatsGet(chatId);
      if (!raw) {
        this.cache.delete(chatId);
        return undefined;
      }
      const info = chatInfoFromRaw(raw);
      // chats.get has no last_message_at; keep the one we already know.
      if (!info.last_message_at && cached?.info.last_message_at) {
        info.last_message_at = cached.info.last_message_at;
      }
      this.remember(info);
      return info;
    }

    // Older imsg: refresh from a wide chats.list, rate-limited unless the caller needs fresh data.
    if (opts.fresh || this.now() - this.lastFullRefresh >= FULL_REFRESH_MIN_INTERVAL_MS) {
      if (opts.fresh) this.cache.delete(chatId);
      await this.list(FULL_REFRESH_LIMIT);
    }
    return this.cache.get(chatId)?.info;
  }
}
