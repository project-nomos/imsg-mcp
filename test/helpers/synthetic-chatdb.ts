/**
 * Builds a synthetic Messages database (chat.db) with the tables and columns imsg reads,
 * modelled on imsg's own test fixture (Tests/IMsgCoreTests/MessageDatabaseFixture.swift).
 * The real `imsg rpc --db <file>` can serve it, which lets tests exercise the real imsg
 * binary without Full Disk Access and without touching anyone's messages.
 */
import { Database } from "bun:sqlite";
import { fixtureDb, type FixtureDb } from "./fixtures";

/** Seconds between the Unix epoch and Apple's reference date (2001-01-01). */
const APPLE_EPOCH_OFFSET_S = 978_307_200;

export function appleNanos(iso: string): number {
  return (Date.parse(iso) / 1000 - APPLE_EPOCH_OFFSET_S) * 1_000_000_000;
}

const SCHEMA = `
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT,
  handle_id INTEGER,
  text TEXT,
  associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0,
  thread_originator_guid TEXT,
  destination_caller_id TEXT,
  balloon_bundle_id TEXT,
  date INTEGER,
  is_from_me INTEGER,
  service TEXT
);
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY,
  chat_identifier TEXT,
  guid TEXT,
  display_name TEXT,
  service_name TEXT,
  account_id TEXT,
  account_login TEXT,
  last_addressed_handle TEXT,
  reserved TEXT
);
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
CREATE TABLE attachment (
  ROWID INTEGER PRIMARY KEY,
  filename TEXT,
  transfer_name TEXT,
  uti TEXT,
  mime_type TEXT,
  total_bytes INTEGER,
  is_sticker INTEGER
);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
`;

interface FixtureChat {
  id: number;
  identifier: string;
  guid: string;
  display_name?: string;
  service: string;
  participants: string[];
}

interface FixtureMessage {
  id: number;
  chat_id: number;
  guid: string;
  sender: string;
  is_from_me: boolean;
  text: string;
  created_at: string;
  attachments?: {
    filename: string;
    transfer_name: string;
    uti: string;
    mime_type: string;
    total_bytes: number;
  }[];
}

/** Writes `fixture` (the same data the stub imsg uses) into a new chat.db at `path`. */
export function buildChatDb(path: string, fixture: FixtureDb = fixtureDb()): void {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const chats = fixture.chats as unknown as FixtureChat[];
  const handles = new Map<string, number>();
  const handleId = (h: string): number => {
    let id = handles.get(h);
    if (id === undefined) {
      id = handles.size + 1;
      handles.set(h, id);
      db.query("INSERT INTO handle (ROWID, id) VALUES (?, ?)").run(id, h);
    }
    return id;
  };
  for (const c of chats) {
    db.query(
      "INSERT INTO chat (ROWID, chat_identifier, guid, display_name, service_name) VALUES (?, ?, ?, ?, ?)",
    ).run(c.id, c.identifier, c.guid, c.display_name ?? "", c.service);
    for (const p of c.participants) {
      db.query("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(
        c.id,
        handleId(p),
      );
    }
  }
  for (const m of fixture.messages as unknown as FixtureMessage[]) {
    insertMessage(db, handleId, m);
  }
  db.close();
}

function insertMessage(db: Database, handleId: (h: string) => number, m: FixtureMessage): void {
  const date = appleNanos(m.created_at);
  const chat = db.query("SELECT service_name FROM chat WHERE ROWID = ?").get(m.chat_id) as {
    service_name: string;
  } | null;
  db.query(
    `INSERT INTO message (ROWID, guid, handle_id, text, associated_message_type, date, is_from_me, service)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    m.id,
    m.guid,
    m.is_from_me || !m.sender ? 0 : handleId(m.sender),
    m.text,
    date,
    m.is_from_me ? 1 : 0,
    chat?.service_name ?? "iMessage",
  );
  db.query(
    "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
  ).run(m.chat_id, m.id, date);
  for (const a of m.attachments ?? []) {
    const res = db
      .query(
        "INSERT INTO attachment (filename, transfer_name, uti, mime_type, total_bytes, is_sticker) VALUES (?, ?, ?, ?, ?, 0)",
      )
      .run(a.filename, a.transfer_name, a.uti, a.mime_type, a.total_bytes);
    db.query("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)").run(
      m.id,
      Number(res.lastInsertRowid),
    );
  }
}

/** Appends one message to an existing chat.db, as Messages would. Returns its rowid. */
export function appendChatDbMessage(
  path: string,
  msg: {
    chat_id: number;
    text: string;
    sender?: string;
    is_from_me?: boolean;
    created_at?: string;
  },
): number {
  const db = new Database(path);
  try {
    const next =
      ((db.query("SELECT MAX(ROWID) AS max FROM message").get() as { max: number | null }).max ??
        0) + 1;
    const handleId = (h: string): number => {
      const row = db.query("SELECT ROWID FROM handle WHERE id = ?").get(h) as {
        ROWID: number;
      } | null;
      if (row) return row.ROWID;
      return Number(db.query("INSERT INTO handle (id) VALUES (?)").run(h).lastInsertRowid);
    };
    insertMessage(db, handleId, {
      id: next,
      chat_id: msg.chat_id,
      guid: `SYNTH-${next}`,
      sender: msg.sender ?? "",
      is_from_me: msg.is_from_me ?? false,
      text: msg.text,
      created_at: msg.created_at ?? new Date().toISOString(),
    });
    return next;
  } finally {
    db.close();
  }
}
