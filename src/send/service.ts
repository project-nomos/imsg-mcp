import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { AttachmentError, attachmentFile, findMessage } from "../attachments/files";
import { parseAttachmentId } from "../attachments/ref";
import type { Identity } from "../auth/access";
import type { Config } from "../config/schema";
import type { ConfigStore } from "../config/store";
import type { ChatDirectory } from "../core/chats";
import type { CursorIndex } from "../core/cursor-index";
import { isoSeconds, parseIsoMs } from "../core/format";
import { normalizeHandle } from "../core/handles";
import { chatInScope } from "../core/scope";
import type { ImsgApi, SendTarget } from "../core/imsg-api";
import { ImsgError } from "../imsg/errors";
import type { MessagesApp } from "../imsg/messages-app";
import type { RawAttachment, RawMessage, SendResult } from "../imsg/types";
import type { AuditLog, AuditRecord } from "../log/audit";
import type { Logger } from "../log/logger";
import type { StateDb } from "../store/state-db";
import type { RateLimiter } from "./rate-limiter";
import {
  checkAllowlistChat,
  checkAllowlistHandle,
  checkFile,
  checkFilesEnabled,
  checkLength,
  checkRole,
  SendRefused,
} from "./rules";

/** A new file from the assistant: its name and its content as text or base64. */
export interface NewFileInput {
  name?: unknown;
  text?: unknown;
  base64?: unknown;
}

export interface SendInput {
  to?: string;
  chat_id?: number;
  /** Optional when a file is sent. */
  text?: string;
  /** Send this attachment (forward it). */
  attachment_id?: string;
  /** Send this new file. */
  file?: NewFileInput;
}

export interface SendOutcome {
  /** `sent`: the outgoing row was found in history. `handed_off_unconfirmed`: Messages took it, no row seen yet. */
  status: "sent" | "handed_off_unconfirmed";
  chat_id: number | null;
  /** rowid of the sent message, when confirmed. */
  cursor: number | null;
  sent_at: string;
  /** The file sent with (or instead of) the text. */
  file?: { name: string; bytes: number };
}

/** A file on its way out: where it is, and what the audit log records about it. */
interface OutgoingFile {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  source: "attachment" | "new";
  attachment_id?: string;
  /** Deletes the outbox copy of a new file. */
  cleanup?: () => void;
}

const MB = 1_048_576;
/** New files arrive inside the tool call, so they stay small. */
const NEW_FILE_MAX_BYTES = 5 * MB;
/** imsg copies the file before sending; the outbox copy is removed a little later. */
const OUTBOX_CLEANUP_MS = 60_000;

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
  cursors: CursorIndex;
  store: StateDb;
  /** Only attachments inside this folder can be forwarded. */
  attachmentsDir: string;
  /** Private folder where new files are written before imsg sends them. */
  outboxDir: string;
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

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(MB);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** A file name safe to write: no folders, no control characters, an extension. */
function safeFileName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const kept = Array.from((name.split(/[\\/]/).pop() ?? "").normalize("NFC")).filter((c) => {
    const code = c.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f && c !== ":";
  });
  const base = kept
    .join("")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!base || Array.from(base).length > 120 || !/\.[A-Za-z0-9]{1,10}$/.test(base))
    return undefined;
  return base;
}

function attachmentHasName(a: RawAttachment, name: string): boolean {
  const stored = (a.filename ?? "").split("/").pop();
  return a.transfer_name === name || stored === name;
}

/**
 * The `send_message` pipeline. Rules run in the spec's order and the first failure
 * stops the send:
 *
 * 1. role includes send  2. recipient on the allowlist  3. text length, and the file
 * (sending files is on, the type is allowed, the size is within the limit)  4. rate limit
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
    let file: OutgoingFile | undefined;
    const wantsFile = input.attachment_id !== undefined || input.file !== undefined;
    try {
      const cfg = config.current;
      if (!cfg.send.enabled) throw new SendDisabled();
      checkRole(identity.role); // rule 1
      const hasTo = typeof input.to === "string" && input.to.trim() !== "";
      const hasChat = input.chat_id !== undefined;
      if (hasTo === hasChat) {
        throw new SendInputError("Give exactly one of `to` (phone or email) or `chat_id`.");
      }
      if (input.text !== undefined && typeof input.text !== "string") {
        throw new SendInputError("`text` must be a string.");
      }
      if (input.text === undefined && !wantsFile) {
        throw new SendInputError("`text` is required (or a file: `attachment_id` or `file`).");
      }
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
      // Rule 3: the text (optional with a file), then the file.
      text =
        wantsFile && !input.text?.trim() ? "" : checkLength(input.text ?? "", cfg.send.max_chars);
      if (wantsFile) file = await this.prepareFile(input, cfg);
      // The chat lookup can take seconds; a kill switch flipped meanwhile still applies.
      this.recheck(target, participants, wantsFile);
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
      file?.cleanup?.();
      const message = err instanceof Error ? err.message : String(err);
      audit.record(
        {
          ...base,
          phase: "before",
          status: rule ? "refused" : "error",
          rule,
          text: typeof input.text === "string" ? input.text : undefined,
          file: file ? fileAudit(file) : requestedFile(input),
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
      {
        ...base,
        phase: "before",
        status: "pending",
        rule: "passed",
        recipient: target,
        text: text || undefined,
        file: file ? fileAudit(file) : undefined,
      },
      true,
    );
    try {
      return await this.deliver(identity, base, started, target, text, participants, file);
    } finally {
      // imsg copies the file before sending; drop the outbox copy once it surely has.
      if (file?.cleanup) setTimeout(file.cleanup, OUTBOX_CLEANUP_MS).unref?.();
    }
  }

  /** Hands the send to imsg, confirms it in history, and writes the "after" audit record. */
  private async deliver(
    identity: Identity,
    base: AuditRecord,
    started: number,
    target: SendTarget,
    text: string,
    participants: string[] | undefined,
    file: OutgoingFile | undefined,
  ): Promise<SendOutcome> {
    const { audit, logger } = this.deps;
    const sentAt = this.now();
    const expect: Expected = { text, fileName: file ? basename(file.path) : undefined };

    let result: SendResult | undefined;
    let timedOut = false;
    try {
      result = await this.dispatch(target, expect, file?.path, sentAt, base, participants);
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

    const confirmed = await this.confirm(target, expect, sentAt, result);
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
      ...(file ? { file: { name: file.name, bytes: file.bytes } } : {}),
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

  /**
   * Rule 3 for a file: finds the attachment to forward (in a chat the caller may read)
   * or writes the new file to the outbox, then checks that it may be sent.
   */
  private async prepareFile(input: SendInput, cfg: Config): Promise<OutgoingFile> {
    if (input.attachment_id !== undefined && input.file !== undefined) {
      throw new SendInputError("Give `attachment_id` or `file`, not both.");
    }
    checkFilesEnabled(cfg.send.files);
    const maxBytes = cfg.send.max_file_mb * MB;
    if (input.attachment_id !== undefined) {
      const id = String(input.attachment_id);
      const ref = parseAttachmentId(id);
      if (!ref) {
        throw new SendInputError(
          `"${id}" is not an attachment id. Use the "id" of an entry in a message's "attachments" list.`,
        );
      }
      const chat = await this.deps.chats.get(ref.chatId);
      const raw =
        chat && chatInScope(cfg.read.scope, chat)
          ? (await findMessage(this.deps, ref))?.attachments?.[ref.index]
          : undefined;
      if (!raw) throw new SendInputError(`Attachment ${id} was not found.`);
      let found;
      try {
        found = attachmentFile(raw, this.deps.attachmentsDir, Number.MAX_SAFE_INTEGER);
      } catch (err) {
        if (err instanceof AttachmentError) throw new SendRefused("file", err.message);
        throw err;
      }
      // The file on disk is what goes out, so its own name decides the type.
      checkFile({ name: basename(found.path), bytes: found.bytes }, maxBytes);
      return {
        path: found.path,
        name: found.name,
        bytes: found.bytes,
        sha256: sha256File(found.path),
        source: "attachment",
        attachment_id: id,
      };
    }

    const f = input.file ?? {};
    const name = safeFileName(f.name);
    if (!name) {
      throw new SendInputError(
        "`file.name` must be a file name with an extension, such as invite.ics.",
      );
    }
    const hasText = typeof f.text === "string";
    if (hasText === (typeof f.base64 === "string")) {
      throw new SendInputError(
        "Give the file's content as exactly one of `file.text` or `file.base64`.",
      );
    }
    let content: Buffer;
    if (hasText) {
      content = Buffer.from(f.text as string, "utf8");
    } else {
      // Standard or URL-safe alphabet, with or without padding.
      const b64 = (f.base64 as string).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
      const unpadded = b64.replace(/=+$/, "");
      if (
        !/^[A-Za-z0-9+/]*$/.test(unpadded) ||
        unpadded.length % 4 === 1 ||
        b64.length - unpadded.length > 2
      ) {
        throw new SendInputError("`file.base64` is not valid base64.");
      }
      content = Buffer.from(unpadded, "base64");
    }
    checkFile({ name, bytes: content.length }, Math.min(maxBytes, NEW_FILE_MAX_BYTES));
    mkdirSync(this.deps.outboxDir, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(this.deps.outboxDir, "send-"));
    const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o600 });
    return {
      path,
      name,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      source: "new",
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  /** Re-checks `send.enabled`, the allowlist and (with a file) `send.files` against the live config. */
  private recheck(target: SendTarget, participants: string[] | undefined, hasFile: boolean): void {
    const cfg = this.deps.config.current;
    if (!cfg.send.enabled) throw new SendDisabled();
    if ("to" in target) checkAllowlistHandle(target.to, cfg.send.allowlist);
    else checkAllowlistChat(target.chat_id, participants ?? [], cfg.send.allowlist);
    if (hasFile) checkFilesEnabled(cfg.send.files);
  }

  /**
   * Calls `send`. If it fails because Messages.app is not running (or imsg says the
   * send never started), opens Messages and retries once, after checking that the first
   * attempt did not land after all and that sending is still allowed.
   */
  private async dispatch(
    target: SendTarget,
    expect: Expected,
    filePath: string | undefined,
    sentAt: number,
    base: AuditRecord,
    participants: string[] | undefined,
  ): Promise<SendResult> {
    const { api, messagesApp, config, audit, logger } = this.deps;
    try {
      return await api.send(target, expect.text, filePath);
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
      const landed = await this.findSent(target, expect, sentAt, undefined);
      if (landed) return { ok: true, id: landed.id };
      this.recheck(target, participants, filePath !== undefined);
      audit.record({ ...base, phase: "retry", status: "pending", error: err.message }, true);
      return await api.send(target, expect.text, filePath);
    }
  }

  /** Polls history for the outgoing row for up to `send.confirm_timeout_ms`. */
  private async confirm(
    target: SendTarget,
    expect: Expected,
    sentAt: number,
    result: SendResult | undefined,
  ): Promise<RawMessage | undefined> {
    const deadline = this.now() + this.deps.config.current.send.confirm_timeout_ms;
    for (;;) {
      try {
        const found = await this.findSent(target, expect, sentAt, result?.id);
        if (found) return found;
      } catch (err) {
        this.deps.logger.debug("send confirmation lookup failed", { error: err as Error });
      }
      if (this.now() >= deadline) return undefined;
      await this.sleep(Math.min(CONFIRM_POLL_MS, Math.max(0, deadline - this.now())));
    }
  }

  /**
   * The outgoing row for this send: imsg's rowid when it gave one, else the newest
   * matching outgoing row (by text; by the file's name for a file without text).
   */
  private async findSent(
    target: SendTarget,
    expect: Expected,
    sentAt: number,
    rowid: number | undefined,
  ): Promise<RawMessage | undefined> {
    const chatIds = "chat_id" in target ? [target.chat_id] : await this.directChatIds(target.to);
    const start = new Date(sentAt - CLOCK_SLACK_MS).toISOString();
    const byFile = !expect.text && expect.fileName !== undefined;
    for (const chatId of chatIds) {
      const messages = await this.deps.api.history({
        chat_id: chatId,
        limit: 10,
        start,
        attachments: byFile,
      });
      const match = messages.find((m) => {
        if (!m.is_from_me) return false;
        if (rowid !== undefined && m.id === rowid) return true;
        const at = parseIsoMs(m.created_at);
        if (at !== undefined && at < sentAt - CLOCK_SLACK_MS) return false;
        if (!byFile) return sameText(m.text, expect.text);
        return (m.attachments ?? []).some((a) => attachmentHasName(a, expect.fileName!));
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

/** What the confirmation looks for in history. */
interface Expected {
  text: string;
  fileName: string | undefined;
}

/** What the audit log keeps about a file: never its content. */
function fileAudit(file: OutgoingFile): Record<string, unknown> {
  return {
    name: file.name,
    bytes: file.bytes,
    sha256: file.sha256,
    source: file.source,
    ...(file.attachment_id ? { attachment_id: file.attachment_id } : {}),
  };
}

/** The file a refused send asked for, as far as it is known. */
function requestedFile(input: SendInput): Record<string, unknown> | undefined {
  if (input.attachment_id !== undefined) {
    return { attachment_id: String(input.attachment_id).slice(0, 64) };
  }
  if (input.file !== undefined) {
    return { name: typeof input.file.name === "string" ? input.file.name.slice(0, 120) : null };
  }
  return undefined;
}
