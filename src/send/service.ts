import { randomUUID } from "node:crypto";
import type { Identity } from "../auth/access";
import type { ConfigStore } from "../config/store";
import type { ChatDirectory } from "../core/chats";
import { isoSeconds, parseIsoMs } from "../core/format";
import { normalizeHandle } from "../core/handles";
import type { ImsgApi, SendTarget } from "../core/imsg-api";
import { ImsgError } from "../imsg/errors";
import type { MessagesApp } from "../imsg/messages-app";
import type { RawMessage, SendResult } from "../imsg/types";
import type { AuditLog, AuditRecord } from "../log/audit";
import type { Logger } from "../log/logger";
import type { RateLimiter } from "./rate-limiter";
import {
  checkAllowlistChat,
  checkAllowlistHandle,
  checkLength,
  checkRole,
  SendRefused,
} from "./rules";

export interface SendInput {
  to?: string;
  chat_id?: number;
  text: string;
}

export interface SendOutcome {
  /** `sent`: the outgoing row was found in history. `handed_off_unconfirmed`: Messages took it, no row seen yet. */
  status: "sent" | "handed_off_unconfirmed";
  chat_id: number | null;
  /** rowid of the sent message, when confirmed. */
  cursor: number | null;
  sent_at: string;
}

/** Sending is turned off in config. Not one of the four rules; the tool is normally absent. */
export class SendDisabled extends Error {
  constructor() {
    super("Sending is turned off on this server (send.enabled = false).");
    this.name = "SendDisabled";
  }
}

/** The arguments do not describe one recipient (or are malformed). */
export class SendInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendInputError";
  }
}

/** The send call failed or its outcome is unknown. */
export class SendFailed extends Error {
  constructor(
    message: string,
    /** False when the message may have gone out; never retry automatically then. */
    readonly retrySafe: boolean,
  ) {
    super(message);
    this.name = "SendFailed";
  }
}

export interface SendServiceDeps {
  api: ImsgApi;
  chats: ChatDirectory;
  config: ConfigStore;
  rate: RateLimiter;
  audit: AuditLog;
  logger: Logger;
  messagesApp: MessagesApp;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const CONFIRM_POLL_MS = 1_000;
const CLOCK_SLACK_MS = 5_000;

function sameText(a: string | undefined, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return norm(a ?? "") === norm(b);
}

/**
 * The `send_message` pipeline. Rules run in the spec's order and the first failure
 * stops the send:
 *
 * 1. role includes send  2. recipient on the allowlist  3. text length  4. rate limit
 *
 * Then the send is written to the audit log (fsynced), handed to `imsg send`, and
 * confirmed by finding the outgoing row in `messages.history` within 10 s. A second
 * audit record captures the result. Every refused or failed call is audited too.
 * Sends run one at a time, and `send.enabled` and the allowlist are checked again
 * against the live config right before dispatch and before any retry, so the kill
 * switch also stops a send that was already in progress.
 */
export class SendService {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: SendServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  send(identity: Identity, input: SendInput): Promise<SendOutcome> {
    const run = this.chain.then(() => this.sendNow(identity, input));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sendNow(identity: Identity, input: SendInput): Promise<SendOutcome> {
    const { audit, chats, config, rate, logger } = this.deps;
    const started = this.now();
    const base: AuditRecord = {
      request_id: randomUUID(),
      identity: identity.id,
      identity_kind: identity.kind,
      tool: "send_message",
      status: "pending",
      recipient: input.to !== undefined ? { to: input.to } : { chat_id: input.chat_id },
    };

    let target: SendTarget;
    let text: string;
    let participants: string[] | undefined;
    try {
      const cfg = config.current;
      if (!cfg.send.enabled) throw new SendDisabled();
      checkRole(identity.role); // rule 1
      const hasTo = typeof input.to === "string" && input.to.trim() !== "";
      const hasChat = input.chat_id !== undefined;
      if (hasTo === hasChat) {
        throw new SendInputError("Give exactly one of `to` (phone or email) or `chat_id`.");
      }
      if (typeof input.text !== "string") throw new SendInputError("`text` is required.");
      if (hasTo) {
        target = { to: checkAllowlistHandle(input.to!, cfg.send.allowlist) }; // rule 2
      } else {
        const chatId = input.chat_id!;
        if (!Number.isSafeInteger(chatId) || chatId <= 0) {
          throw new SendInputError("`chat_id` must be a positive integer.");
        }
        const chat = await chats.get(chatId, { fresh: true });
        if (!chat) throw new SendRefused("allowlist", `chat ${chatId} was not found`);
        checkAllowlistChat(chat.chat_id, chat.participants, cfg.send.allowlist); // rule 2
        target = { chat_id: chat.chat_id };
        participants = chat.participants;
      }
      text = checkLength(input.text, cfg.send.max_chars); // rule 3
      // The chat lookup can take seconds; a kill switch flipped meanwhile still applies.
      this.recheck(target, participants);
      const slot = rate.tryAcquire(config.current.send.rate, identity.id); // rule 4
      if (!slot.ok) {
        throw new SendRefused(
          "rate",
          `the ${slot.full.window} limit is used up; the next send is possible after ${slot.full.next_slot_at}`,
        );
      }
    } catch (err) {
      const rule =
        err instanceof SendRefused
          ? err.rule
          : err instanceof SendDisabled
            ? "send.enabled"
            : undefined;
      const message = err instanceof Error ? err.message : String(err);
      audit.record(
        {
          ...base,
          phase: "before",
          status: rule ? "refused" : "error",
          rule,
          text: typeof input.text === "string" ? input.text : undefined,
          error: message.slice(0, 500),
          duration_ms: this.now() - started,
        },
        true,
      );
      if (rule) logger.info("send refused", { identity: identity.id, rule });
      else
        logger.warn("send rejected before dispatch", {
          identity: identity.id,
          error: message.slice(0, 300),
        });
      throw err;
    }

    // Written (and fsynced) before Messages is touched, so a crash mid-send leaves a record.
    audit.record(
      { ...base, phase: "before", status: "pending", rule: "passed", recipient: target, text },
      true,
    );
    const sentAt = this.now();

    let result: SendResult | undefined;
    let timedOut = false;
    try {
      result = await this.dispatch(target, text, sentAt, base, participants);
    } catch (err) {
      if (err instanceof ImsgError && err.kind === "timeout") {
        timedOut = true; // Outcome unknown; look for the row before reporting anything.
      } else if (err instanceof SendDisabled || err instanceof SendRefused) {
        // The kill switch or the allowlist changed before the retry; nothing was resent.
        audit.record(
          {
            ...base,
            phase: "after",
            status: "refused",
            rule: err instanceof SendRefused ? err.rule : "send.enabled",
            error: err.message,
            duration_ms: this.now() - started,
          },
          true,
        );
        throw err;
      } else {
        const retrySafe = err instanceof ImsgError ? err.notStarted : false;
        const message = err instanceof Error ? err.message : String(err);
        audit.record(
          {
            ...base,
            phase: "after",
            status: "failed",
            error: message,
            duration_ms: this.now() - started,
          },
          true,
        );
        logger.warn("send failed", { identity: identity.id, error: message });
        throw new SendFailed(
          `Send failed: ${message}.${retrySafe ? "" : " It may or may not have been delivered; check get_messages before trying again."}`,
          retrySafe,
        );
      }
    }

    const confirmed = await this.confirm(target, text, sentAt, result);
    if (!confirmed && timedOut) {
      audit.record(
        {
          ...base,
          phase: "after",
          status: "failed",
          error: "send timed out; outcome unknown",
          duration_ms: this.now() - started,
        },
        true,
      );
      throw new SendFailed(
        "Send timed out and the message was not found in history. It may still be delivered; check get_messages before trying again.",
        false,
      );
    }
    const outcome: SendOutcome = {
      status: confirmed ? "sent" : "handed_off_unconfirmed",
      chat_id: confirmed?.chat_id ?? ("chat_id" in target ? target.chat_id : null),
      cursor: confirmed?.id ?? null,
      sent_at: isoSeconds(confirmed?.created_at ?? sentAt),
    };
    audit.record(
      {
        ...base,
        phase: "after",
        status: outcome.status,
        cursor: outcome.cursor,
        chat_id: outcome.chat_id,
        duration_ms: this.now() - started,
      },
      true,
    );
    logger.info("send done", {
      identity: identity.id,
      status: outcome.status,
      chat_id: outcome.chat_id,
    });
    return outcome;
  }

  /** Re-checks `send.enabled` and the allowlist against the live config. */
  private recheck(target: SendTarget, participants: string[] | undefined): void {
    const cfg = this.deps.config.current;
    if (!cfg.send.enabled) throw new SendDisabled();
    if ("to" in target) checkAllowlistHandle(target.to, cfg.send.allowlist);
    else checkAllowlistChat(target.chat_id, participants ?? [], cfg.send.allowlist);
  }

  /**
   * Calls `send`. If it fails because Messages.app is not running (or imsg says the
   * send never started), opens Messages and retries once, after checking that the first
   * attempt did not land after all and that sending is still allowed.
   */
  private async dispatch(
    target: SendTarget,
    text: string,
    sentAt: number,
    base: AuditRecord,
    participants: string[] | undefined,
  ): Promise<SendResult> {
    const { api, messagesApp, config, audit, logger } = this.deps;
    try {
      return await api.send(target, text);
    } catch (err) {
      if (
        !(err instanceof ImsgError) ||
        err.kind === "timeout" ||
        err.kind === "delivery_unknown"
      ) {
        throw err;
      }
      const running = await messagesApp.isRunning();
      if (running && !err.notStarted) throw err;
      if (!running) {
        if (!config.current.health.relaunch_messages) throw err;
        logger.warn("Messages.app is not running; opening it and retrying the send once");
        await messagesApp.launch();
        await this.sleep(3_000);
      }
      const landed = await this.findSent(target, text, sentAt, undefined);
      if (landed) return { ok: true, id: landed.id };
      this.recheck(target, participants);
      audit.record({ ...base, phase: "retry", status: "pending", error: err.message }, true);
      return await api.send(target, text);
    }
  }

  /** Polls history for the outgoing row for up to `send.confirm_timeout_ms`. */
  private async confirm(
    target: SendTarget,
    text: string,
    sentAt: number,
    result: SendResult | undefined,
  ): Promise<RawMessage | undefined> {
    const deadline = this.now() + this.deps.config.current.send.confirm_timeout_ms;
    for (;;) {
      try {
        const found = await this.findSent(target, text, sentAt, result?.id);
        if (found) return found;
      } catch (err) {
        this.deps.logger.debug("send confirmation lookup failed", { error: err as Error });
      }
      if (this.now() >= deadline) return undefined;
      await this.sleep(Math.min(CONFIRM_POLL_MS, Math.max(0, deadline - this.now())));
    }
  }

  private async findSent(
    target: SendTarget,
    text: string,
    sentAt: number,
    rowid: number | undefined,
  ): Promise<RawMessage | undefined> {
    const chatIds = "chat_id" in target ? [target.chat_id] : await this.directChatIds(target.to);
    const start = new Date(sentAt - CLOCK_SLACK_MS).toISOString();
    for (const chatId of chatIds) {
      const messages = await this.deps.api.history({ chat_id: chatId, limit: 10, start });
      const match = messages.find((m) => {
        if (!m.is_from_me) return false;
        if (rowid !== undefined && m.id === rowid) return true;
        const at = parseIsoMs(m.created_at);
        return sameText(m.text, text) && (at === undefined || at >= sentAt - CLOCK_SLACK_MS);
      });
      if (match) return match;
    }
    return undefined;
  }

  /** 1:1 chats with this handle, most recently active first (iMessage and SMS can both exist). */
  private async directChatIds(handle: string): Promise<number[]> {
    const chats = await this.deps.chats.list(25);
    return chats
      .filter((c) => {
        if (c.is_group) return false;
        if (normalizeHandle(c.identifier) === handle) return true;
        return c.participants.length === 1 && normalizeHandle(c.participants[0] ?? "") === handle;
      })
      .slice(0, 3)
      .map((c) => c.chat_id);
  }
}
