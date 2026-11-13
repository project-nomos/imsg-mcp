import type { App } from "../app";
import { VERSION } from "../version";

export interface HealthSnapshot {
  healthy: boolean;
  problems: string[];
  checked_at: string;
  version: string;
  imsg: {
    version: string;
    child_alive: boolean;
    pid: number | null;
    restarts: number;
    consecutive_timeouts: number;
    last_exit: { at: string; code: number | null; signal: string | null } | null;
  };
  messages_app_running: boolean | null;
  watch: {
    subscribed: boolean;
    in_sync: boolean;
    cursor: number;
    seconds_since_last_event: number | null;
    last_inbound_at: string | null;
    last_error: string | null;
    sync: App["watcher"]["sync"];
  };
  last_history_ok_at: string | null;
  heartbeat: { configured: boolean; last_sent_at: string | null; last_error: string | null };
}

function iso(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

/**
 * Background checks for an unattended Mac: Messages.app is running (relaunching it
 * if not), the watch is in sync, and an outbound heartbeat goes out every 5 minutes
 * while healthy, so a dead-man's switch (e.g. Healthchecks.io) notices when it stops.
 */
export class HealthMonitor {
  messagesRunning: boolean | undefined;
  private lastRelaunchAt = 0;
  private heartbeatSentAt: number | undefined;
  private heartbeatError: string | undefined;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private firstHeartbeat: ReturnType<typeof setTimeout> | undefined;
  private syncRetry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly app: App,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Starts the timers. Stdio mode passes `heartbeat: false`: several local copies may run. */
  start(opts: { heartbeat?: boolean } = {}): void {
    const cfg = this.app.config.current;
    void this.checkMessagesApp().catch(() => undefined);
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => {
        fn().catch((err) => this.app.logger.warn("health task failed", { error: err as Error }));
      }, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(cfg.health.messages_check_interval_seconds * 1000, () => this.checkMessagesApp());
    every(cfg.health.sync_check_interval_seconds * 1000, () => this.syncCheck());
    if (opts.heartbeat !== false) {
      every(cfg.heartbeat.interval_seconds * 1000, () => this.heartbeat());
      // First heartbeat shortly after startup, once the watch had a chance to subscribe.
      const first = setTimeout(() => void this.heartbeat(), 30_000);
      first.unref?.();
      this.firstHeartbeat = first;
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    if (this.firstHeartbeat) clearTimeout(this.firstHeartbeat);
    if (this.syncRetry) clearTimeout(this.syncRetry);
  }

  /** Runs the watch sync check; after a failure, tries again in a minute rather than ten. */
  async syncCheck(): Promise<void> {
    const sync = await this.app.watcher.syncCheck();
    if (sync.error && !this.syncRetry) {
      this.syncRetry = setTimeout(() => {
        this.syncRetry = undefined;
        void this.syncCheck();
      }, 60_000);
      this.syncRetry.unref?.();
    }
  }

  async checkMessagesApp(): Promise<boolean> {
    const running = await this.app.messagesApp.isRunning();
    this.messagesRunning = running;
    const cfg = this.app.config.current;
    if (
      !running &&
      cfg.health.relaunch_messages &&
      this.app.now() - this.lastRelaunchAt > 300_000
    ) {
      this.lastRelaunchAt = this.app.now();
      this.app.logger.warn("Messages.app is not running; opening it");
      try {
        await this.app.messagesApp.launch();
        this.messagesRunning = await this.app.messagesApp.isRunning();
      } catch (err) {
        this.app.logger.error("could not open Messages.app", { error: err as Error });
      }
    }
    return this.messagesRunning;
  }

  snapshot(): HealthSnapshot {
    const { app } = this;
    const rpc = app.rpc.stats();
    const watcher = app.watcher;
    const problems: string[] = [];
    if (!rpc.alive) problems.push("imsg rpc child is not running");
    if (this.messagesRunning === false) problems.push("Messages.app is not running");
    if (!watcher.subscribed) problems.push("watch is not subscribed");
    else if (watcher.sync.error) problems.push(`sync check failed: ${watcher.sync.error}`);
    else if (watcher.sync.behind) problems.push("watch is behind the Messages database");
    const now = app.now();
    return {
      healthy: problems.length === 0 && this.messagesRunning !== undefined,
      problems,
      checked_at: new Date(now).toISOString(),
      version: VERSION,
      imsg: {
        version: app.status.version,
        child_alive: rpc.alive,
        pid: rpc.pid ?? null,
        restarts: rpc.restarts,
        consecutive_timeouts: rpc.consecutive_timeouts,
        last_exit: rpc.last_exit,
      },
      messages_app_running: this.messagesRunning ?? null,
      watch: {
        subscribed: watcher.subscribed,
        in_sync: watcher.inSync,
        cursor: app.store.getCursor(),
        seconds_since_last_event:
          watcher.lastEventAt === undefined ? null : Math.round((now - watcher.lastEventAt) / 1000),
        last_inbound_at: iso(watcher.lastInboundAt),
        last_error: watcher.lastError ?? null,
        sync: watcher.sync,
      },
      last_history_ok_at: iso(app.api.lastHistoryOkAt),
      heartbeat: {
        configured: !!app.config.current.heartbeat.url,
        last_sent_at: iso(this.heartbeatSentAt),
        last_error: this.heartbeatError ?? null,
      },
    };
  }

  /** Pings `heartbeat.url` only while healthy. */
  async heartbeat(): Promise<boolean> {
    const url = this.app.config.current.heartbeat.url;
    if (!url) return false;
    const snap = this.snapshot();
    if (!snap.healthy) {
      this.app.logger.warn("unhealthy; skipping heartbeat", { problems: snap.problems });
      return false;
    }
    try {
      const res = await this.fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.heartbeatSentAt = this.app.now();
      this.heartbeatError = undefined;
      return true;
    } catch (err) {
      this.heartbeatError = (err as Error).message;
      this.app.logger.warn("heartbeat failed", { error: this.heartbeatError });
      return false;
    }
  }
}
