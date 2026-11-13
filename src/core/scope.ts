import type { ReadScopeConfig } from "../config/schema";
import { normalizeHandle } from "./handles";

/** The parts of a chat that decide whether it is readable. */
export interface ChatRef {
  chat_id: number;
  identifier?: string | null;
  guid?: string | null;
  participants?: string[];
  is_group?: boolean;
}

export function isGroupChat(chat: ChatRef): boolean {
  if (typeof chat.is_group === "boolean") return chat.is_group;
  return (
    (chat.guid ?? "").includes(";+;") ||
    (chat.identifier ?? "").includes(";+;") ||
    (chat.participants?.length ?? 0) > 1
  );
}

/**
 * Whether a chat is inside `read.scope`.
 *
 * - `all` allows everything.
 * - A chat id, chat identifier or chat GUID entry allows that chat.
 * - A handle entry (E.164 or email) allows the 1:1 chat with that handle only.
 *   Group chats must be listed by chat id, so adding someone to a group never
 *   widens what can be read.
 */
export function chatInScope(scope: ReadScopeConfig, chat: ChatRef): boolean {
  if (scope.mode === "all") return true;
  if (scope.chatIds.has(chat.chat_id)) return true;
  if (chat.identifier && scope.chatKeys.has(chat.identifier)) return true;
  if (chat.guid && scope.chatKeys.has(chat.guid)) return true;
  if (scope.handles.size === 0 || isGroupChat(chat)) return false;

  const participants = (chat.participants ?? []).map((p) => normalizeHandle(p));
  if (participants.length > 1) return false;
  if (participants.length === 1) {
    const only = participants[0];
    return !!only && scope.handles.has(only);
  }
  const fromIdentifier = chat.identifier ? normalizeHandle(chat.identifier) : undefined;
  return !!fromIdentifier && scope.handles.has(fromIdentifier);
}
