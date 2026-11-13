import type { ImsgRpcClient } from "../imsg/rpc-client";
import type { ImsgStatus } from "../imsg/status";
import {
  asRawChat,
  asRawMessage,
  listOf,
  type RawChat,
  type RawMessage,
  type SendResult,
} from "../imsg/types";
import { ImsgError } from "../imsg/errors";

export interface HistoryParams {
  chat_id: number;
  limit: number;
  start?: string;
  end?: string;
  attachments?: boolean;
}

export type SendTarget = { to: string } | { chat_id: number };

/**
 * Typed calls to `imsg rpc`. Sends only documented params: newer imsg versions reject
 * unknown keys, older ones ignore them.
 */
export class ImsgApi {
  lastHistoryOkAt: number | undefined;

  constructor(
    private readonly rpc: ImsgRpcClient,
    private readonly status: () => ImsgStatus,
    private readonly now: () => number = Date.now,
  ) {}

  has(method: string): boolean {
    return this.status().rpcMethods.has(method);
  }

  async chatsList(limit: number): Promise<RawChat[]> {
    const result = await this.rpc.call("chats.list", { limit: Math.max(1, Math.floor(limit)) });
    return listOf(result, "chats", asRawChat);
  }

  /** One chat by id (imsg 0.16+). Returns undefined when the chat does not exist. */
  async chatsGet(chatId: number): Promise<RawChat | undefined> {
    try {
      const result = await this.rpc.call("chats.get", { chat_id: chatId });
      return asRawChat(result);
    } catch (err) {
      if (err instanceof ImsgError && err.kind === "invalid_params") return undefined;
      throw err;
    }
  }

  /** Messages for one chat, newest first (imsg's order). */
  async history(p: HistoryParams): Promise<RawMessage[]> {
    const params: Record<string, unknown> = {
      chat_id: p.chat_id,
      limit: Math.max(1, Math.floor(p.limit)),
    };
    if (p.start) params.start = p.start;
    if (p.end) params.end = p.end;
    if (p.attachments) params.attachments = true;
    const result = await this.rpc.call("messages.history", params);
    this.lastHistoryOkAt = this.now();
    return listOf(result, "messages", asRawMessage);
  }

  /** Full-text search across all chats (imsg 0.14+), at most 100 results. */
  async search(query: string, limit: number): Promise<RawMessage[]> {
    const result = await this.rpc.call("messages.search", {
      query,
      limit: Math.min(100, Math.max(1, Math.floor(limit))),
    });
    return listOf(result, "messages", asRawMessage);
  }

  async send(target: SendTarget, text: string): Promise<SendResult> {
    const params: Record<string, unknown> =
      "to" in target ? { to: target.to, text } : { chat_id: target.chat_id, text };
    const result = await this.rpc.call<SendResult>("send", params);
    return result && typeof result === "object" ? result : {};
  }

  async watchSubscribe(sinceRowid: number | undefined): Promise<number> {
    const params: Record<string, unknown> = { attachments: true };
    if (sinceRowid && sinceRowid > 0) params.since_rowid = sinceRowid;
    const result = await this.rpc.call<{ subscription?: unknown }>("watch.subscribe", params);
    const id = result?.subscription;
    if (typeof id !== "number") {
      throw new ImsgError("watch.subscribe returned no subscription id", "rpc", true);
    }
    return id;
  }

  async watchUnsubscribe(subscription: number): Promise<void> {
    await this.rpc.call("watch.unsubscribe", { subscription });
  }
}
