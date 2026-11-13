import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AttachmentMeta {
  name: string;
  mime: string | null;
  bytes: number | null;
  missing?: boolean;
}

/** One inbound message as kept in `state.db`. Text is stored in full and cut on output. */
export interface InboundRow {
  rowid: number;
  chat_id: number;
  chat_identifier: string | null;
  chat_guid: string | null;
  chat_name: string | null;
  is_group: boolean;
  participants: string[];
  sender: string | null;
  sender_name: string | null;
  sent_at: string;
  sent_at_ms: number;
  service: string | null;
  text: string;
  attachments: AttachmentMeta[];
  edited: boolean;
  unsent: boolean;
  stored_at_ms: number;
}

interface InboundDbRow {
  rowid: number;
  chat_id: number;
  chat_identifier: string | null;
  chat_guid: string | null;
  chat_name: string | null;
  is_group: number;
  participants: string;
  sender: string | null;
  sender_name: string | null;
  sent_at: string;
  sent_at_ms: number;
  service: string | null;
  text: string;
  attachments: string;
  edited: number;
  unsent: number;
  stored_at_ms: number;
}

const SCHEMA_VERSION = 1;

function parseJsonArray<T>(s: string): T[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function fromDb(r: InboundDbRow): InboundRow {
  return {
    ...r,
    is_group: r.is_group === 1,
    participants: parseJsonArray<string>(r.participants),
    attachments: parseJsonArray<AttachmentMeta>(r.attachments),
    edited: r.edited === 1,
    unsent: r.unsent === 1,
  };
}

/**
 * Local SQLite state: the inbound message store behind `check_new_messages`, the watch
 * cursor that lets a restart resume without gaps, and send timestamps for rate limiting.
 * The file is created with mode 0600.
 */
export class StateDb {
  readonly db: Database;

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    const existed = path !== ":memory:" && existsSync(path);
    this.db = new Database(path, { create: true });
    if (path !== ":memory:" && !existed) chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.query("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound (
        rowid INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        chat_identifier TEXT,
        chat_guid TEXT,
        chat_name TEXT,
        is_group INTEGER NOT NULL DEFAULT 0,
        participants TEXT NOT NULL DEFAULT '[]',
        sender TEXT,
        sender_name TEXT,
        sent_at TEXT NOT NULL,
        sent_at_ms INTEGER NOT NULL,
        service TEXT,
        text TEXT NOT NULL DEFAULT '',
        attachments TEXT NOT NULL DEFAULT '[]',
        edited INTEGER NOT NULL DEFAULT 0,
        unsent INTEGER NOT NULL DEFAULT 0,
        stored_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbound_chat ON inbound (chat_id, rowid);
      CREATE INDEX IF NOT EXISTS inbound_sent ON inbound (sent_at_ms);
      CREATE TABLE IF NOT EXISTS sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        identity TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sends_at ON sends (at_ms);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  // ---- meta / cursor -------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Highest Messages rowid the watcher has processed (0 when none yet). */
  getCursor(): number {
    const v = Number(this.getMeta("watch_cursor") ?? "0");
    return Number.isSafeInteger(v) && v > 0 ? v : 0;
  }

  /** Moves the cursor forward; never backward. */
  advanceCursor(rowid: number): void {
    if (!Number.isSafeInteger(rowid) || rowid <= 0) return;
    if (rowid > this.getCursor()) this.setMeta("watch_cursor", String(rowid));
  }

  // ---- inbound store -------------------------------------------------------

  /** Stores a message. Returns false when the rowid is already stored. */
  insertInbound(row: Omit<InboundRow, "stored_at_ms">): boolean {
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO inbound
          (rowid, chat_id, chat_identifier, chat_guid, chat_name, is_group, participants, sender,
           sender_name, sent_at, sent_at_ms, service, text, attachments, edited, unsent, stored_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.rowid,
        row.chat_id,
        row.chat_identifier,
        row.chat_guid,
        row.chat_name,
        row.is_group ? 1 : 0,
        JSON.stringify(row.participants),
        row.sender,
        row.sender_name,
        row.sent_at,
        row.sent_at_ms,
        row.service,
        row.text,
        JSON.stringify(row.attachments),
        row.edited ? 1 : 0,
        row.unsent ? 1 : 0,
        this.now(),
      );
    return res.changes > 0;
  }

  /**
   * Records one watched row atomically: stores it (when `row` is given) and moves the
   * cursor to `rowid`. If the insert fails, nothing changes, so the row is replayed on
   * the next subscribe instead of being skipped. Returns whether a new row was stored.
   */
  ingest(row: Omit<InboundRow, "stored_at_ms"> | undefined, rowid: number): boolean {
    let inserted = false;
    this.db.transaction(() => {
      if (row) inserted = this.insertInbound(row);
      this.advanceCursor(rowid);
    })();
    return inserted;
  }

  /** Applies an edit or unsend reported by the watch stream. */
  updateInboundText(rowid: number, text: string, change: "edited" | "unsent"): boolean {
    const res = this.db
      .query(
        change === "unsent"
          ? "UPDATE inbound SET text = '', unsent = 1 WHERE rowid = ?"
          : "UPDATE inbound SET text = ?, edited = 1 WHERE rowid = ?",
      )
      .run(...(change === "unsent" ? [rowid] : [text, rowid]));
    return res.changes > 0;
  }

  findInbound(rowid: number): InboundRow | undefined {
    const row = this.db
      .query("SELECT * FROM inbound WHERE rowid = ?")
      .get(rowid) as InboundDbRow | null;
    return row ? fromDb(row) : undefined;
  }

  /** Rows with rowid > `afterRowid`, oldest first. */
  inboundAfter(afterRowid: number, chatId: number | undefined, limit: number): InboundRow[] {
    const rows = (
      chatId === undefined
        ? this.db
            .query("SELECT * FROM inbound WHERE rowid > ? ORDER BY rowid ASC LIMIT ?")
            .all(afterRowid, limit)
        : this.db
            .query(
              "SELECT * FROM inbound WHERE rowid > ? AND chat_id = ? ORDER BY rowid ASC LIMIT ?",
            )
            .all(afterRowid, chatId, limit)
    ) as InboundDbRow[];
    return rows.map(fromDb);
  }

  /** Rows with rowid < `beforeRowid` sent at or after `sinceMs`, newest first. */
  inboundRecent(
    sinceMs: number,
    beforeRowid: number,
    chatId: number | undefined,
    limit: number,
  ): InboundRow[] {
    const rows = (
      chatId === undefined
        ? this.db
            .query(
              "SELECT * FROM inbound WHERE sent_at_ms >= ? AND rowid < ? ORDER BY rowid DESC LIMIT ?",
            )
            .all(sinceMs, beforeRowid, limit)
        : this.db
            .query(
              "SELECT * FROM inbound WHERE sent_at_ms >= ? AND rowid < ? AND chat_id = ? ORDER BY rowid DESC LIMIT ?",
            )
            .all(sinceMs, beforeRowid, chatId, limit)
    ) as InboundDbRow[];
    return rows.map(fromDb);
  }

  inboundStats(): { count: number; newest_rowid: number | null; newest_sent_at: string | null } {
    const row = this.db
      .query("SELECT COUNT(*) AS count, MAX(rowid) AS newest FROM inbound")
      .get() as { count: number; newest: number | null };
    const newest =
      row.newest === null
        ? null
        : ((this.db.query("SELECT sent_at FROM inbound WHERE rowid = ?").get(row.newest) as {
            sent_at: string;
          } | null) ?? null);
    return { count: row.count, newest_rowid: row.newest, newest_sent_at: newest?.sent_at ?? null };
  }

  // ---- sends (rate limit) --------------------------------------------------

  recordSend(atMs: number, identity: string): void {
    this.db.query("INSERT INTO sends (at_ms, identity) VALUES (?, ?)").run(atMs, identity);
  }

  /** Send times at or after `sinceMs`, oldest first. */
  sendTimesSince(sinceMs: number): number[] {
    const rows = this.db
      .query("SELECT at_ms FROM sends WHERE at_ms >= ? ORDER BY at_ms ASC")
      .all(sinceMs) as { at_ms: number }[];
    return rows.map((r) => r.at_ms);
  }

  // ---- retention -----------------------------------------------------------

  /** Deletes inbound rows past retention and send records older than `sendHorizonMs`. */
  prune(retentionDays: number, sendHorizonMs: number): { inbound: number; sends: number } {
    const now = this.now();
    const inbound = this.db
      .query("DELETE FROM inbound WHERE sent_at_ms < ?")
      .run(now - retentionDays * 86_400_000).changes;
    const sends = this.db
      .query("DELETE FROM sends WHERE at_ms < ?")
      .run(now - sendHorizonMs).changes;
    return { inbound, sends };
  }

  close(): void {
    this.db.close();
  }
}
