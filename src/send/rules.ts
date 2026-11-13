import { roleCanSend, type AllowlistConfig, type Role } from "../config/schema";
import { normalizeHandle } from "../core/handles";

/** Which rule refused a send. Numbered as in the spec. */
export type SendRule = "role" | "allowlist" | "length" | "rate";

export const RULE_NUMBER: Record<SendRule, number> = { role: 1, allowlist: 2, length: 3, rate: 4 };

export class SendRefused extends Error {
  constructor(
    readonly rule: SendRule,
    detail: string,
  ) {
    super(`Send refused by rule ${RULE_NUMBER[rule]} (${rule}): ${detail}`);
    this.name = "SendRefused";
  }
}

/** Rule 1: the caller's role includes send. */
export function checkRole(role: Role): void {
  if (!roleCanSend(role)) {
    throw new SendRefused("role", `the "${role}" role cannot send messages`);
  }
}

/** Rule 2 for a direct send: the normalized handle is on the allowlist. Returns the handle. */
export function checkAllowlistHandle(to: string, allowlist: AllowlistConfig): string {
  const handle = normalizeHandle(to);
  if (!handle) {
    throw new SendRefused(
      "allowlist",
      `"${to}" is not an E.164 phone number (like +14155550123) or an email address`,
    );
  }
  if (!allowlist.handles.has(handle)) {
    throw new SendRefused("allowlist", "the recipient is not on send.allowlist");
  }
  return handle;
}

/**
 * Rule 2 for a chat send: the chat id is on the allowlist, or every participant is.
 * Listing a chat id approves that conversation as a whole; otherwise each member must
 * be approved, so adding a stranger to a group blocks sends to it.
 */
export function checkAllowlistChat(
  chatId: number,
  participants: string[],
  allowlist: AllowlistConfig,
): void {
  if (allowlist.chatIds.has(chatId)) return;
  if (participants.length === 0) {
    throw new SendRefused(
      "allowlist",
      `chat ${chatId} has no known participants and is not on send.allowlist`,
    );
  }
  const missing = participants.filter((p) => {
    const h = normalizeHandle(p);
    return !h || !allowlist.handles.has(h);
  });
  if (missing.length > 0) {
    throw new SendRefused(
      "allowlist",
      `${missing.length} of ${participants.length} participant(s) in chat ${chatId} are not on send.allowlist`,
    );
  }
}

/** Rule 3: 1 to max characters after trimming. Returns the trimmed text. */
export function checkLength(text: string, maxChars: number): string {
  const trimmed = text.trim();
  const length = Array.from(trimmed).length;
  if (length === 0) throw new SendRefused("length", "text is empty");
  if (length > maxChars) {
    throw new SendRefused("length", `text is ${length} characters; the limit is ${maxChars}`);
  }
  return trimmed;
}
