import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Logger } from "../log/logger";
import { truncate } from "../log/logger";
import { fromRpcError, ImsgError, type JsonRpcErrorObject } from "./errors";

export interface RpcClientOptions {
  /** Program and leading args, e.g. `["/opt/homebrew/bin/imsg", "rpc"]`. */
  command: string[];
  logger: Logger;
  /** Per-call timeout. The spec says 10 s. */
  callTimeoutMs: number;
  /** First restart delay after the child exits; doubles up to `restartMaxMs`. */
  restartInitialMs: number;
  restartMaxMs: number;
  /** After this much uptime, the next crash restarts with the initial delay again. */
  stableAfterMs?: number;
  /** Restart a child that is alive but has let this many calls in a row time out. */
  stuckAfterTimeouts?: number;
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RpcClientEvents {
  /** A notification (no `id`) such as `message` or `watch.overflow`. */
  notification: [method: string, params: unknown];
  /** A child process was spawned. `generation` counts spawns from 1. */
  started: [generation: number];
  /** The child exited. A restart is scheduled unless the client was stopped. */
  exit: [info: { code: number | null; signal: NodeJS.Signals | null; restartInMs?: number }];
}

/**
 * Supervises one long-lived `imsg rpc` child and speaks JSON-RPC 2.0 to it, one JSON
 * object per line. stderr goes to the server log and never into the RPC stream.
 *
 * - Every call times out after `callTimeoutMs`.
 * - When the child exits, in-flight calls fail with a retryable error and the child
 *   restarts after 1 s, doubling to 30 s (configurable).
 * - A child that stays alive but stops answering (several timeouts in a row) is killed
 *   and restarted the same way.
 * - Listener errors are contained, so a bug or a failed write while handling one
 *   notification can never stall the stream for everything after it.
 */
export class ImsgRpcClient extends EventEmitter<RpcClientEvents> {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private backoffMs: number;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private startedAt = 0;
  private generationCount = 0;
  private lastExit: { at: number; code: number | null; signal: string | null } | undefined;
  private restarts = 0;
  private consecutiveTimeouts = 0;

  constructor(private readonly opts: RpcClientOptions) {
    super();
    this.backoffMs = opts.restartInitialMs;
  }

  get alive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  get generation(): number {
    return this.generationCount;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  stats(): {
    alive: boolean;
    pid: number | undefined;
    restarts: number;
    consecutive_timeouts: number;
    uptime_seconds: number | null;
    last_exit: { at: string; code: number | null; signal: string | null } | null;
  } {
    return {
      alive: this.alive,
      pid: this.pid,
      restarts: this.restarts,
      consecutive_timeouts: this.consecutiveTimeouts,
      uptime_seconds: this.alive ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      last_exit: this.lastExit
        ? {
            at: new Date(this.lastExit.at).toISOString(),
            code: this.lastExit.code,
            signal: this.lastExit.signal,
          }
        : null,
    };
  }

  start(): void {
    this.stopped = false;
    this.spawnChild();
  }

  private spawnChild(): void {
    this.restartTimer = undefined;
    if (this.stopped) return;
    const [program, ...args] = this.opts.command;
    if (!program) throw new Error("imsg command is empty");
    const log = this.opts.logger;

    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.opts.env ?? process.env,
      });
    } catch (err) {
      log.error("failed to spawn imsg rpc", { error: err as Error });
      this.scheduleRestart(null, null);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.consecutiveTimeouts = 0;
    this.generationCount += 1;
    const generation = this.generationCount;

    child.stdin?.on("error", (err) => {
      // EPIPE when the child dies mid-write; the exit handler does the cleanup.
      log.debug("imsg stdin error", { error: err });
    });

    const stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    stdout.on("line", (line) => {
      try {
        this.handleLine(line);
      } catch (err) {
        // An exception escaping a readline listener can stop the stream for good.
        log.error("failed to handle a line from imsg rpc", { error: err as Error });
      }
    });

    const stderr = createInterface({ input: child.stderr!, crlfDelay: Infinity });
    stderr.on("line", (line) => {
      if (line.trim()) log.info("imsg stderr", { line: truncate(line, 300) });
    });

    let exited = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      if (this.child === child) this.child = undefined;
      this.failPending(new ImsgError("imsg rpc exited; retry shortly", "unavailable", true));
      this.lastExit = { at: Date.now(), code, signal };
      this.scheduleRestart(code, signal);
    };
    child.on("exit", onExit);
    child.on("error", (err) => {
      log.error("imsg rpc process error", { error: err });
      onExit(null, null);
    });

    log.info("imsg rpc started", { pid: child.pid, generation });
    this.emit("started", generation);
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopped) {
      this.emit("exit", { code, signal });
      return;
    }
    const uptime = Date.now() - this.startedAt;
    if (uptime >= (this.opts.stableAfterMs ?? 60_000)) this.backoffMs = this.opts.restartInitialMs;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.restartMaxMs);
    this.restarts += 1;
    this.opts.logger.warn("imsg rpc exited; restarting", { code, signal, restart_in_ms: delay });
    this.emit("exit", { code, signal, restartInMs: delay });
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.spawnChild(), delay);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Never log the line itself: it could hold message text.
      this.opts.logger.warn("imsg rpc wrote a non-JSON line", { length: line.length });
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const id = msg.id;
    if (typeof id === "number" && ("result" in msg || "error" in msg)) {
      this.consecutiveTimeouts = 0;
      const pending = this.pending.get(id);
      if (!pending) return; // Late reply after a timeout.
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(fromRpcError(pending.method, msg.error as JsonRpcErrorObject));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && (id === undefined || id === null)) {
      try {
        this.emit("notification", msg.method, msg.params);
      } catch (err) {
        this.opts.logger.error("notification handler failed", {
          method: msg.method,
          error: err as Error,
        });
      }
      return;
    }
    if (msg.error) {
      const err = fromRpcError("imsg", msg.error as JsonRpcErrorObject);
      this.opts.logger.warn("imsg rpc protocol error", { error: err.message });
    }
  }

  /**
   * Calls an `imsg rpc` method. Rejects with a retryable ImsgError when the child is
   * down or the call times out.
   */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const child = this.child;
    if (!child || !this.alive || !child.stdin || child.stdin.destroyed) {
      return Promise.reject(
        new ImsgError("imsg rpc is not running (restarting); retry shortly", "unavailable", true),
      );
    }
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.opts.callTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new ImsgError(`${method}: timed out after ${timeout} ms`, "timeout", true));
          this.noteTimeout(child);
        }
      }, timeout);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      const request: Record<string, unknown> = { jsonrpc: "2.0", id, method };
      if (params !== undefined) request.params = params;
      child.stdin!.write(`${JSON.stringify(request)}\n`, (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new ImsgError(`${method}: could not write to imsg rpc`, "unavailable", true));
        }
      });
    });
  }

  /** Kills a child that is alive but has stopped answering; the supervisor restarts it. */
  private noteTimeout(child: ChildProcess): void {
    if (child !== this.child) return;
    this.consecutiveTimeouts += 1;
    const limit = this.opts.stuckAfterTimeouts ?? 3;
    if (this.consecutiveTimeouts >= limit && this.alive) {
      this.opts.logger.error("imsg rpc stopped answering; restarting it", {
        consecutive_timeouts: this.consecutiveTimeouts,
      });
      this.consecutiveTimeouts = 0;
      child.kill("SIGKILL");
    }
  }

  private failPending(err: ImsgError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new ImsgError(`${pending.method}: ${err.message}`, err.kind, err.retryable));
    }
  }

  /** Kills the current child; the supervisor restarts it. Used for recovery and tests. */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child?.kill(signal);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    if (!child || !this.alive) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.stdin?.end();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }, 1_500).unref?.();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 4_000).unref?.();
    });
    this.failPending(new ImsgError("server is shutting down", "unavailable", true));
  }
}
