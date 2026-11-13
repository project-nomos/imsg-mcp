import type { JWTVerifyGetKey } from "jose";
import { AccessVerifier } from "./auth/access";
import type { Config } from "./config/schema";
import type { ConfigStore } from "./config/store";
import { ChatDirectory } from "./core/chats";
import { CursorIndex } from "./core/cursor-index";
import { ImsgApi } from "./core/imsg-api";
import { InboundWatcher } from "./core/watcher";
import { systemMessagesApp, type MessagesApp } from "./imsg/messages-app";
import { ImsgRpcClient } from "./imsg/rpc-client";
import {
  missingRequiredMethods,
  readImsgStatus,
  resolveImsgPath,
  type ImsgStatus,
} from "./imsg/status";
import type { AuditLog } from "./log/audit";
import type { Logger } from "./log/logger";
import { RateLimiter } from "./send/rate-limiter";
import { SendService } from "./send/service";
import { StateDb } from "./store/state-db";

export interface AppOptions {
  config: ConfigStore;
  logger: Logger;
  audit: AuditLog;
  /** Path of state.db (or `:memory:`). */
  stateDbPath: string;
  /** Command prefix that runs imsg. Defaults to the resolved `imsg.path`. Tests point it at a stub. */
  imsgCommand?: string[];
  /** Environment for the imsg child and status probe. Defaults to this process's. */
  imsgEnv?: NodeJS.ProcessEnv;
  messagesApp?: MessagesApp;
  /** JWKS override for tests. */
  keySource?: JWTVerifyGetKey;
  /** How the server is being served, for get_status. */
  mode: "http" | "stdio" | "selftest";
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

/** Everything a running server needs, wired together. One per process. */
export class App {
  readonly config: ConfigStore;
  readonly logger: Logger;
  readonly audit: AuditLog;
  readonly store: StateDb;
  readonly rpc: ImsgRpcClient;
  readonly api: ImsgApi;
  readonly chats: ChatDirectory;
  readonly cursors = new CursorIndex();
  readonly watcher: InboundWatcher;
  readonly rate: RateLimiter;
  readonly sender: SendService;
  readonly messagesApp: MessagesApp;
  readonly mode: AppOptions["mode"];
  readonly startedAt: number;
  readonly now: () => number;
  /** The binary macOS privacy grants must name (this executable). */
  readonly binaryPath: string;
  /** `imsg status --json` from startup: what the running child supports. */
  status: ImsgStatus;
  /** Command prefix that runs imsg. */
  readonly imsgCommand: string[];
  private readonly imsgEnv: NodeJS.ProcessEnv | undefined;
  private verifier: AccessVerifier | undefined;
  private readonly keySource: JWTVerifyGetKey | undefined;
  private retentionTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(opts: AppOptions, status: ImsgStatus, imsgCommand: string[]) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.audit = opts.audit;
    this.mode = opts.mode;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.status = status;
    this.imsgCommand = imsgCommand;
    this.imsgEnv = opts.imsgEnv;
    this.keySource = opts.keySource;
    this.messagesApp = opts.messagesApp ?? systemMessagesApp;
    this.binaryPath = process.execPath;
    const cfg = opts.config.current;

    this.store = new StateDb(opts.stateDbPath, this.now);
    this.rpc = new ImsgRpcClient({
      command: [...imsgCommand, "rpc", ...(cfg.imsg.db ? ["--db", cfg.imsg.db] : [])],
      logger: opts.logger.child({ component: "imsg" }),
      callTimeoutMs: cfg.imsg.call_timeout_ms,
      restartInitialMs: cfg.imsg.restart_initial_ms,
      restartMaxMs: cfg.imsg.restart_max_ms,
      env: opts.imsgEnv,
    });
    this.api = new ImsgApi(this.rpc, () => this.status, this.now);
    this.chats = new ChatDirectory(this.api, this.now);
    this.watcher = new InboundWatcher({
      rpc: this.rpc,
      api: this.api,
      store: this.store,
      chats: this.chats,
      config: this.config,
      logger: opts.logger.child({ component: "watch" }),
      now: this.now,
    });
    this.rate = new RateLimiter(this.store, this.now);
    this.sender = new SendService({
      api: this.api,
      chats: this.chats,
      config: this.config,
      rate: this.rate,
      audit: this.audit,
      logger: opts.logger.child({ component: "send" }),
      messagesApp: this.messagesApp,
      now: this.now,
      sleep: opts.sleep,
    });
  }

  /**
   * Checks `imsg status --json` and refuses to start when a required RPC method is
   * missing, then opens the state database. Call `start()` to launch the child.
   */
  static async create(opts: AppOptions): Promise<App> {
    const cfg = opts.config.current;
    const imsgCommand = opts.imsgCommand ?? [resolveImsgPath(cfg.imsg.path)];
    let status: ImsgStatus;
    try {
      status = await readImsgStatus(imsgCommand, opts.imsgEnv);
    } catch (err) {
      throw new StartupError(
        `could not run "${imsgCommand.join(" ")} status --json": ${(err as Error).message}. ` +
          `Install imsg (brew install steipete/tap/imsg) or set imsg.path in the config.`,
      );
    }
    const missing = missingRequiredMethods(status);
    if (missing.length) {
      throw new StartupError(
        `imsg ${status.version} is missing required RPC methods: ${missing.join(", ")}. ` +
          `Upgrade imsg (brew upgrade steipete/tap/imsg).`,
      );
    }
    opts.logger.info("imsg detected", {
      version: status.version,
      rpc_methods: [...status.rpcMethods].sort(),
    });
    return new App(opts, status, imsgCommand);
  }

  start(): void {
    this.rpc.start();
    this.watcher.start();
    this.prune();
    this.retentionTimer = setInterval(() => this.prune(), 3_600_000);
    this.retentionTimer.unref?.();
  }

  /**
   * Runs `imsg status --json` again (for get_status). The installed imsg can be newer
   * than the running child after an upgrade, so this does not replace `status`.
   */
  async installedImsgStatus(): Promise<ImsgStatus | undefined> {
    try {
      return await readImsgStatus(this.imsgCommand, this.imsgEnv);
    } catch (err) {
      this.logger.warn("imsg status failed", { error: err as Error });
      return undefined;
    }
  }

  /** Deletes inbound messages past `store.retention_days` and stale rate-limit rows. */
  prune(): void {
    const cfg = this.config.current;
    const horizon = Math.max(86_400_000, ...cfg.send.rate.map((w) => w.windowMs)) * 2;
    try {
      const removed = this.store.prune(cfg.store.retention_days, horizon);
      if (removed.inbound || removed.sends) this.logger.info("pruned state", removed);
    } catch (err) {
      this.logger.error("prune failed", { error: err as Error });
    }
  }

  /** The Access verifier for the current config, rebuilt when the team or AUDs change. */
  accessVerifier(): AccessVerifier {
    const access: Config["access"] = this.config.current.access;
    if (!access.team_domain || access.aud.length === 0) {
      throw new Error("access.team_domain and access.aud must be configured");
    }
    if (
      !this.verifier ||
      !this.verifier.matches(access.team_domain, access.aud, access.clock_tolerance_seconds)
    ) {
      this.verifier = new AccessVerifier({
        teamDomain: access.team_domain,
        audiences: access.aud,
        clockToleranceSeconds: access.clock_tolerance_seconds,
        keySource: this.keySource,
      });
    }
    return this.verifier;
  }

  async stop(): Promise<void> {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.watcher.stop();
    await this.rpc.stop();
    try {
      this.store.close();
    } catch {
      // already closed
    }
  }
}
