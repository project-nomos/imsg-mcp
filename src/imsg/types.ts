/**
 * Shapes returned by `imsg rpc` (snake_case JSON). Fields are optional because imsg
 * omits strings that don't apply and adds fields over time; see imsg's docs/json.md.
 * Verified against imsg 0.8.2 and 0.21.0.
 */

export interface RawChat {
  id: number;
  name?: string;
  display_name?: string;
  contact_name?: string;
  identifier?: string;
  guid?: string;
  service?: string;
  last_message_at?: string;
  is_group?: boolean;
  participants?: string[];
}

export interface RawAttachment {
  filename?: string;
  transfer_name?: string;
  uti?: string;
  mime_type?: string;
  /** imsg's payloads use `total_bytes`; its docs say `byte_size`. Accept both. */
  total_bytes?: number;
  byte_size?: number;
  is_sticker?: boolean;
  missing?: boolean;
}

export interface RawMessage {
  id: number;
  chat_id: number;
  guid?: string;
  chat_identifier?: string;
  chat_guid?: string;
  chat_name?: string;
  participants?: string[];
  is_group?: boolean;
  sender?: string;
  sender_name?: string;
  is_from_me?: boolean;
  text?: string;
  created_at?: string;
  attachments?: RawAttachment[];
  is_reaction?: boolean;
  /** `edited` or `unsent` on watch mutation updates (imsg 0.15+). Absent on new rows. */
  type?: string;
  edited_at?: string;
  unsent_at?: string;
  reply_to_guid?: string;
}

export interface SendResult {
  ok?: boolean;
  id?: number;
  guid?: string;
  transport?: string;
  service?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function asRawChat(v: unknown): RawChat | undefined {
  if (!isObject(v) || typeof v.id !== "number") return undefined;
  return v as unknown as RawChat;
}

export function asRawMessage(v: unknown): RawMessage | undefined {
  if (!isObject(v) || typeof v.id !== "number" || typeof v.chat_id !== "number") return undefined;
  return v as unknown as RawMessage;
}

export function listOf<T>(value: unknown, key: string, guard: (v: unknown) => T | undefined): T[] {
  if (!isObject(value)) return [];
  const list = value[key];
  if (!Array.isArray(list)) return [];
  const out: T[] = [];
  for (const item of list) {
    const parsed = guard(item);
    if (parsed) out.push(parsed);
  }
  return out;
}
