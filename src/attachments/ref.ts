/**
 * Attachment ids as shown to the assistant: `<chat_id>-<message cursor>-<index>`, for
 * example `1-14-0` is the first attachment of message 14 in chat 1. They are derived from
 * the message, so nothing has to be stored to resolve them later.
 */
export interface AttachmentRef {
  chatId: number;
  /** The message's rowid (its `cursor`). */
  rowid: number;
  /** Position in the message's attachment list, from 0. */
  index: number;
}

export function formatAttachmentId(chatId: number, rowid: number, index: number): string {
  return `${chatId}-${rowid}-${index}`;
}

export function parseAttachmentId(id: string): AttachmentRef | undefined {
  const m = /^(\d{1,9})-(\d{1,15})-(\d{1,3})$/.exec(id.trim());
  if (!m) return undefined;
  const ref = { chatId: Number(m[1]), rowid: Number(m[2]), index: Number(m[3]) };
  if (ref.chatId <= 0 || ref.rowid <= 0 || !Number.isSafeInteger(ref.rowid)) return undefined;
  return ref;
}
