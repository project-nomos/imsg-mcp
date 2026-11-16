import { realpathSync, statSync } from "node:fs";
import type { CursorIndex } from "../core/cursor-index";
import type { ImsgApi } from "../core/imsg-api";
import type { RawAttachment, RawMessage } from "../imsg/types";
import { effectiveHome } from "../paths";
import type { StateDb } from "../store/state-db";
import type { AttachmentFile } from "./convert";
import type { AttachmentRef } from "./ref";

/** A problem with an attachment; the message is meant for the assistant. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

const HISTORY_PAGE = 200;
const HISTORY_PAGES = 5;
const AROUND_MS = 2_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Reads message `ref.rowid` of chat `ref.chatId` with its attachments. imsg 0.14+ reads it
 * directly by rowid; older imsg reads history around the time the message was sent
 * (known when it was listed or stored), or scans the newest 1,000 messages of the chat.
 */
export async function findMessage(
  deps: { api: ImsgApi; cursors: CursorIndex; store: StateDb },
  ref: Pick<AttachmentRef, "chatId" | "rowid">,
): Promise<RawMessage | undefined> {
  const { api } = deps;
  if (api.has("messages.after")) {
    const page = await api.after({
      since_rowid: ref.rowid - 1,
      chat_id: ref.chatId,
      limit: 1,
      attachments: true,
    });
    return page.messages.find((m) => m.id === ref.rowid && m.chat_id === ref.chatId);
  }
  const known = deps.cursors.get(ref.rowid);
  const stored = deps.store.findInbound(ref.rowid);
  const at =
    known && known.chatId === ref.chatId
      ? known.sentAtMs
      : stored && stored.chat_id === ref.chatId
        ? stored.sent_at_ms
        : undefined;
  if (at !== undefined) {
    const around = await api.history({
      chat_id: ref.chatId,
      limit: 50,
      start: iso(at - AROUND_MS),
      end: iso(at + AROUND_MS),
      attachments: true,
    });
    const hit = around.find((m) => m.id === ref.rowid);
    if (hit) return hit;
  }
  let end: string | undefined;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const batch = await api.history({
      chat_id: ref.chatId,
      limit: HISTORY_PAGE,
      end,
      attachments: true,
    });
    const hit = batch.find((m) => m.id === ref.rowid);
    if (hit) return hit;
    const oldest = batch[batch.length - 1];
    if (batch.length < HISTORY_PAGE || !oldest?.created_at) break;
    end = oldest.created_at;
  }
  return undefined;
}

/** The name an attachment was sent with, or its stored file name. */
export function attachmentName(a: RawAttachment): string {
  const stored = a.filename ? (a.filename.split("/").pop() ?? "") : "";
  return a.transfer_name || stored || "attachment";
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? effectiveHome() + path.slice(1) : path;
}

/**
 * Checks that an attachment's file is on disk, is a regular file inside the Messages
 * attachments folder (after resolving symlinks), and is at most `maxBytes`. The folder
 * check keeps a crafted database row or path from reaching any other file on the Mac.
 */
export function attachmentFile(
  a: RawAttachment,
  attachmentsDir: string,
  maxBytes: number,
): AttachmentFile {
  const name = attachmentName(a);
  const raw = a.original_path || (a.filename ? expandHome(a.filename) : "");
  if (a.missing || !raw) {
    throw new AttachmentError(
      `"${name}" is not on this Mac any more (Messages may have removed it, or it is only in iCloud).`,
    );
  }
  let root: string;
  try {
    root = realpathSync(attachmentsDir);
  } catch {
    throw new AttachmentError("The Messages attachments folder was not found on this Mac.");
  }
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    throw new AttachmentError(`"${name}" is not on this Mac any more.`);
  }
  if (!real.startsWith(`${root}/`)) {
    throw new AttachmentError(
      `"${name}" is outside the Messages attachments folder, so it is not opened.`,
    );
  }
  const st = statSync(real);
  if (!st.isFile()) throw new AttachmentError(`"${name}" is not a file.`);
  if (st.size > maxBytes) {
    const mb = (n: number) => `${Math.round((n / 1_048_576) * 10) / 10} MB`;
    throw new AttachmentError(`"${name}" is ${mb(st.size)}; the limit is ${mb(maxBytes)}.`);
  }
  return {
    path: real,
    name,
    mime: a.mime_type || null,
    uti: a.uti || null,
    bytes: st.size,
  };
}
