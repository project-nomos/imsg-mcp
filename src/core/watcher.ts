import type { ConfigStore } from "../config/store";
import { ImsgError } from "../imsg/errors";
import type { ImsgRpcClient } from "../imsg/rpc-client";
import { asRawMessage, type RawMessage } from "../imsg/types";
import type { Logger } from "../log/logger";
import type { InboundRow, StateDb } from "../store/state-db";
import type { ChatDirectory } from "./chats";
import { chatInfoFromMessage, messageFromRaw, parseIsoMs } from "./format";
import type { ImsgApi } from "./imsg-api";
import { chatInScope } from "./scope";

const BACKFILL_WINDOW_MS = 24 * 3_600_000;
const BACKFILL_MAX_CHATS = 100;
const BACKFILL_PER_CHAT = 200;
const RESUBSCRIBE_RETRY_MS = 30_000;
/** A row this much newer than our cursor and older than this many ms means we fell behind. */
const SYNC_GRACE_MS = 60_000;
/** Cursor this far past the newest row suggests chat.db was replaced (rowids restarted). */
const CURSOR_AHEAD_MARGIN = 10_000;
/** Notifications held while a subscribe is in flight; beyond this, resubscribe instead. */
const MAX_BUFFERED_NOTIFICATIONS = 20_000;
const RECOVERY_INITIAL_MS = 2_000;
const RECOVERY_MAX_MS = 60_000;
const DAY_MS = 86_400_000;
const PERMISSION_RESTART_MIN_INTERVAL_MS = 60_000;
/** After (re)subscribing, imsg replays rows past the cursor; give that burst time to land. */
const SETTLE_MS = 1_500;

export interface SyncState {
  checked_at: string | null;
  db_newest_rowid: number | null;
  cursor: number;
  behind: boolean;
  resubscribes: number;
  note: string | null;
  /** Set when the last sync check failed; the server reports unhealthy until one succeeds. */
  error: string | null;
}

export interface WatcherDeps {
  rpc: ImsgRpcClient;
  api: ImsgApi;
  store: StateDb;
  chats: ChatDirectory;
  config: ConfigStore;
  logger: Logger;
  now?: () => number;
}

/**
 * Keeps one `watch.subscribe` stream open for all chats and writes inbound messages
 * into the local store. Each row is stored and the cursor moved in one transaction, so
 * a restart (or a failed write) resubscribes from the last row really processed and
 * nothing is lost.
 */
export class InboundWatcher {
  private subscription: number | undefined;
  private subscribedGeneration = 0;
  private inflight: Promise<void> | undefined;
  private rerun: { reason: string; sinceOverride: number | undefined } | undefined;
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  private lastPermissionRestart = 0;
  private lastBehindRowid: number | undefined;
  private readonly now: () => number;
  private started = false;
  /** True while watch.subscribe is in flight; notifications are held until its id is known. */
  private subscribing = false;
  private buffered: { method: string; params: Record<string, unknown> }[] = [];
  private bufferOverflowed = false;
  private recoveryDelayMs = RECOVERY_INITIAL_MS;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private warnedCursorAhead: number | undefined;

  lastEventAt: number | undefined;
  lastInboundAt: number | undefined;
  lastSubscribedAt: number | undefined;
  lastError: string | undefined;
  /** Set when imsg reported missing permissions; cleared by the next successful subscribe. */
  permissionDenied = false;
  readonly sync: SyncState = {
    checked_at: null,
    db_newest_rowid: null,
    cursor: 0,
    behind: false,
    resubscribes: 0,
    note: null,
    error: null,
  };

  constructor(private readonly deps: WatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  get subscribed(): boolean {
    return (
      this.subscription !== undefined && this.subscribedGeneration === this.deps.rpc.generation
    );
  }

  get subscriptionId(): number | undefined {
    return this.subscribed ? this.subscription : undefined;
  }

  /**
   * Resolves once a subscribe/backfill in progress has finished and the replay burst
   * after the latest subscription has had time to arrive (at most `maxWaitMs`).
   * `check_new_messages` waits on this so a call right after startup is complete.
   */
  async settled(maxWaitMs = 5_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const busy = this.inflight !== undefined;
      const fresh =
        this.lastSubscribedAt !== undefined && this.now() - this.lastSubscribedAt < SETTLE_MS;
      if (!busy && !fresh) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Healthy means subscribed, and the last sync check neither failed nor found us behind. */
  get inSync(): boolean {
    return this.subscribed && !this.sync.behind && !this.sync.error;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { rpc } = this.deps;
    rpc.on("notification", (method, params) => this.onNotification(method, params));
    rpc.on("started", () => {
      this.subscription = undefined;
      void this.ensureSubscribed("imsg rpc started");
    });
    rpc.on("exit", () => {
      this.subscription = undefined;
    });
    if (rpc.alive) void this.ensureSubscribed("startup");
    this.retryTimer = setInterval(() => {
      if (!this.subscribed && rpc.alive) void this.ensureSubscribed("retry");
    }, RESUBSCRIBE_RETRY_MS);
    this.retryTimer.unref?.();
  }

  stop(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  /**
   * Subscribes (or resubscribes) from the saved cursor. Concurrent callers share one
   * attempt; a request that arrives mid-attempt runs once more afterwards if still needed.
   */
  ensureSubscribed(reason: string, sinceOverride?: number): Promise<void> {
    if (this.inflight) {
      this.rerun = { reason, sinceOverride };
      return this.inflight;
    }
    const run = async () => {
      try {
        await this.subscribe(reason, sinceOverride);
      } finally {
        this.inflight = undefined;
      }
      const rerun = this.rerun;
      this.rerun = undefined;
      if (rerun && (!this.subscribed || rerun.sinceOverride !== undefined)) {
        await this.ensureSubscribed(rerun.reason, rerun.sinceOverride);
      }
    };
    this.inflight = run();
    return this.inflight;
  }

  /** Drops the current stream and subscribes again from the saved cursor. */
  resubscribe(reason: string, sinceOverride?: number): Promise<void> {
    this.sync.resubscribes += 1;
    return this.ensureSubscribed(reason, sinceOverride);
  }

  private async subscribe(reason: string, sinceOverride?: number): Promise<void> {
    const { api, store, logger, rpc } = this.deps;
    const old = this.subscription;
    this.subscription = undefined;
    if (old !== undefined && this.subscribedGeneration === rpc.generation) {
      try {
        await api.watchUnsubscribe(old);
      } catch {
        // The old stream may already be gone; subscribing again is what matters.
      }
    }
    const cursor = store.getCursor();
    const since =
      sinceOverride !== undefined ? Math.min(sinceOverride, cursor || sinceOverride) : cursor;
    const generation = rpc.generation;
    // imsg may start streaming the backlog before it answers watch.subscribe (0.8 can);
    // hold those notifications until we know the new subscription id.
    this.subscribing = true;
    this.buffered = [];
    this.bufferOverflowed = false;
    try {
      const id = await api.watchSubscribe(since > 0 ? since : undefined);
      if (generation !== rpc.generation) return; // The child restarted meanwhile.
      this.subscription = id;
      this.subscribedGeneration = generation;
      this.lastSubscribedAt = this.now();
      this.lastError = undefined;
      this.permissionDenied = false;
      logger.info("watch subscribed", { reason, subscription: id, since_rowid: since || null });
      const held = this.buffered;
      const overflowed = this.bufferOverflowed;
      this.subscribing = false;
      this.buffered = [];
      for (const note of held) {
        if (note.params.subscription === id) this.dispatch(note.method, note.params);
      }
      if (overflowed) this.scheduleRecovery("too many notifications while subscribing");
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error("watch.subscribe failed", { reason, error: this.lastError });
      this.maybeRestartForPermissions(err);
      return;
    } finally {
      this.subscribing = false;
      this.buffered = [];
    }
    if (cursor === 0) {
      // First start (or no message seen yet): fill the last 24 h so
      // check_new_messages has something to return. The live stream already covers
      // anything newer, and the store ignores duplicates.
      try {
        await this.backfill();
      } catch (err) {
        logger.warn("backfill failed", { error: err as Error });
      }
    }
  }

  /**
   * imsg 0.8 answers every request with the same permission error until the child is
   * restarted, so after Full Disk Access is granted the child must be restarted to notice.
   */
  private maybeRestartForPermissions(err: unknown): void {
    if (!(err instanceof ImsgError) || err.kind !== "permission") return;
    this.permissionDenied = true;
    if (this.now() - this.lastPermissionRestart < PERMISSION_RESTART_MIN_INTERVAL_MS) return;
    this.lastPermissionRestart = this.now();
    this.deps.logger.warn("restarting imsg rpc to re-check permissions");
    this.deps.rpc.kill();
  }

  /**
   * Drops the current stream and resubscribes from the saved cursor after a delay that
   * grows on repeated failures. Used when a row could not be recorded.
   */
  private scheduleRecovery(reason: string): void {
    this.subscription = undefined;
    if (this.recoveryTimer) return;
    const delay = this.recoveryDelayMs;
    this.recoveryDelayMs = Math.min(this.recoveryDelayMs * 2, RECOVERY_MAX_MS);
    this.deps.logger.warn("resubscribing from the saved cursor", { reason, delay_ms: delay });
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.resubscribe(reason);
    }, delay);
    this.recoveryTimer.unref?.();
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    if (p.subscription !== undefined && p.subscription !== this.subscription) {
      if (this.subscribing) {
        if (this.buffered.length < MAX_BUFFERED_NOTIFICATIONS)
          this.buffered.push({ method, params: p });
        else this.bufferOverflowed = true;
      }
      return;
    }
    this.dispatch(method, p);
  }

  private dispatch(method: string, p: Record<string, unknown>): void {
    try {
      this.handleNotification(method, p);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.deps.logger.error("watch notification failed", { method, error: err as Error });
      this.scheduleRecovery("notification handling failed");
    }
  }

  private handleNotification(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case "message":
        this.handleMessage(p.message);
        return;
      case "watch.overflow": {
        // imsg 0.15+: the stream ended because its buffer filled. Resume from its cursor.
        const resume = typeof p.resume_after_rowid === "number" ? p.resume_after_rowid : undefined;
        this.deps.logger.warn("watch overflow; resubscribing", {
          resume_after_rowid: resume ?? null,
        });
        this.subscription = undefined;
        void this.resubscribe("watch overflow", resume);
        return;
      }
      case "error": {
        // imsg 0.8 reports a failed watch stream this way; the subscription is dead.
        const errText =
          p.error && typeof p.error === "object"
            ? String((p.error as Record<string, unknown>).message ?? "watch error")
            : "watch error";
        this.deps.logger.warn("watch stream error; resubscribing", {
          error: errText.slice(0, 200),
        });
        this.subscription = undefined;
        setTimeout(() => void this.ensureSubscribed("watch error"), 2_000).unref?.();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Processes one watched row: stores it if it is inbound, in scope and recent, and moves
   * the cursor, in one transaction. A failure leaves the cursor where it was and
   * resubscribes, so the row is replayed rather than skipped.
   */
  handleMessage(value: unknown): void {
    const m = asRawMessage(value);
    if (!m) return;
    const { store } = this.deps;
    this.lastEventAt = this.now();

    if (m.type === "edited" || m.type === "unsent") {
      // Mutation updates reuse the original rowid and never advance the cursor.
      store.updateInboundText(m.id, m.text ?? "", m.type);
      return;
    }
    const row = this.inboundRow(m);
    if (store.ingest(row, m.id) && row) this.lastInboundAt = this.now();
    this.sync.cursor = store.getCursor();
    this.recoveryDelayMs = RECOVERY_INITIAL_MS;
  }

  /**
   * The row to store for `m`, or undefined when it should not be stored: outgoing,
   * a reaction, outside read.scope (dropped before storage), or dated before the
   * retention window (history that iCloud syncs onto a new Mac is not "new").
   */
  private inboundRow(m: RawMessage): Omit<InboundRow, "stored_at_ms"> | undefined {
    if (m.is_from_me || m.is_reaction) return undefined;
    const cfg = this.deps.config.current;
    const chat = this.deps.chats.peek(m.chat_id) ?? chatInfoFromMessage(m);
    const ref = {
      chat_id: m.chat_id,
      identifier: m.chat_identifier ?? chat.identifier,
      guid: m.chat_guid ?? chat.guid,
      participants: m.participants ?? chat.participants,
      is_group: m.is_group ?? chat.is_group,
    };
    if (!chatInScope(cfg.read.scope, ref)) return undefined;
    const sentAtMs = parseIsoMs(m.created_at) ?? this.now();
    if (sentAtMs < this.now() - cfg.store.retention_days * DAY_MS) return undefined;
    const out = messageFromRaw(m, this.deps.chats.peek(m.chat_id));
    return {
      rowid: m.id,
      chat_id: m.chat_id,
      chat_identifier: ref.identifier || null,
      chat_guid: ref.guid || null,
      chat_name: out.chat_name,
      is_group: !!ref.is_group,
      participants: ref.participants ?? [],
      sender: out.sender,
      sender_name: out.sender_name,
      sent_at: new Date(sentAtMs).toISOString(),
      sent_at_ms: sentAtMs,
      service: out.service,
      text: out.text,
      attachments: out.attachments,
      edited: !!out.edited,
      unsent: !!out.unsent,
    };
  }

  /** Stores inbound messages from the last 24 h of active chats. Runs when there is no cursor. */
  async backfill(): Promise<{ chats: number; stored: number }> {
    const { api, chats, store, logger } = this.deps;
    const since = this.now() - BACKFILL_WINDOW_MS;
    const sinceIso = new Date(since).toISOString();
    const list = await chats.list(BACKFILL_MAX_CHATS);
    let scanned = 0;
    let stored = 0;
    let maxRowid = 0;
    for (const chat of list) {
      const last = parseIsoMs(chat.last_message_at);
      if (last !== undefined && last < since) break; // Sorted newest first.
      if (!chatInScope(this.deps.config.current.read.scope, chat)) continue;
      scanned += 1;
      const messages = await api.history({
        chat_id: chat.chat_id,
        limit: BACKFILL_PER_CHAT,
        start: sinceIso,
        attachments: true,
      });
      for (const m of messages) {
        maxRowid = Math.max(maxRowid, m.id);
        const row = this.inboundRow(m);
        if (row && store.insertInbound(row)) {
          stored += 1;
          this.lastInboundAt = this.now();
        }
      }
    }
    if (maxRowid > 0) store.advanceCursor(maxRowid);
    this.sync.cursor = store.getCursor();
    logger.info("backfill done", { chats: scanned, stored });
    return { chats: scanned, stored };
  }

  /**
   * Compares the newest rowid in `messages.history` with the last one watched. If the
   * database is ahead (by a row older than a minute), resubscribes from the cursor.
   * A failed check is recorded in `sync.error`, which makes the server unhealthy.
   */
  async syncCheck(): Promise<SyncState> {
    this.sync.checked_at = new Date(this.now()).toISOString();
    try {
      await this.runSyncCheck();
      this.sync.error = null;
    } catch (err) {
      this.sync.error = err instanceof Error ? err.message : String(err);
      this.sync.note = "sync check failed";
      this.deps.logger.warn("sync check failed", { error: this.sync.error });
    }
    return this.sync;
  }

  private async runSyncCheck(): Promise<void> {
    const { api, chats, store, logger } = this.deps;
    if (!this.subscribed) {
      this.sync.note = "not subscribed; subscribing";
      await this.ensureSubscribed("sync check: not subscribed");
      if (!this.subscribed) throw new Error(this.lastError ?? "could not subscribe");
      return;
    }
    let newest: RawMessage | undefined;
    for (const chat of await chats.list(5)) {
      const [m] = await api.history({ chat_id: chat.chat_id, limit: 1 });
      if (m && (!newest || m.id > newest.id)) newest = m;
    }
    const cursor = store.getCursor();
    this.sync.cursor = cursor;
    this.sync.db_newest_rowid = newest?.id ?? null;
    if (!newest) {
      this.sync.behind = false;
      this.sync.note = "no messages";
      return;
    }

    if (cursor > newest.id + CURSOR_AHEAD_MARGIN) {
      // Either chat.db was replaced (rowids restarted) or iCloud filled in old history with
      // high rowids. The two look alike from here, so never delete anything automatically.
      const note =
        "the saved cursor is far ahead of the newest message; if chat.db was replaced (new Mac, restore), stop the server and delete state.db";
      this.sync.note = note;
      if (this.warnedCursorAhead !== cursor) {
        this.warnedCursorAhead = cursor;
        logger.warn("saved cursor is far ahead of the newest message", {
          cursor,
          db_newest_rowid: newest.id,
          hint: "if chat.db was replaced, stop the server and delete state.db",
        });
      }
      this.sync.behind = false;
      return;
    }

    const newestAt = parseIsoMs(newest.created_at) ?? this.now();
    const ahead = newest.id > cursor && this.now() - newestAt > SYNC_GRACE_MS;
    if (!ahead) {
      this.sync.behind = false;
      this.sync.note = null;
      this.lastBehindRowid = undefined;
      return;
    }
    if (this.lastBehindRowid === newest.id) {
      // Already resubscribed for this row and the stream still skips it (imsg suppresses
      // some rows, such as link-preview stubs). Don't loop; report it and move on.
      this.sync.behind = false;
      this.sync.note = `row ${newest.id} not emitted by watch after resubscribing; ignoring`;
      return;
    }
    this.lastBehindRowid = newest.id;
    this.sync.behind = true;
    this.sync.note = "watch behind database; resubscribing";
    logger.warn("watch behind database; resubscribing", { cursor, db_newest_rowid: newest.id });
    await this.resubscribe("sync check: behind");
    this.sync.behind = !this.subscribed;
  }
}
