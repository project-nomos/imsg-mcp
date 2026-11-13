import { DailyRotatingFile } from "./rotating-file";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  setLevel(level: LogLevel): void;
}

export interface LoggerSink {
  write(line: string): void;
}

/** Writes one JSON object per line. Never pass message text in fields. */
class JsonLogger implements Logger {
  constructor(
    private readonly sinks: LoggerSink[],
    private readonly state: { level: LogLevel },
    private readonly bound: LogFields = {},
    private readonly stderrMinLevel: LogLevel | "off" = "off",
  ) {}

  private log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < LEVELS[this.state.level]) return;
    const record = { time: new Date().toISOString(), level, msg, ...this.bound, ...fields };
    const line = JSON.stringify(record, errorReplacer);
    for (const sink of this.sinks) {
      try {
        sink.write(line);
      } catch {
        // A logging failure must never take the server down.
      }
    }
    if (this.stderrMinLevel !== "off" && LEVELS[level] >= LEVELS[this.stderrMinLevel]) {
      process.stderr.write(`${line}\n`);
    }
  }

  debug(msg: string, fields?: LogFields): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.log("error", msg, fields);
  }
  child(fields: LogFields): Logger {
    return new JsonLogger(
      this.sinks,
      this.state,
      { ...this.bound, ...fields },
      this.stderrMinLevel,
    );
  }
  setLevel(level: LogLevel): void {
    this.state.level = level;
  }
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message, 500) };
  }
  return value;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface CreateLoggerOptions {
  /** Directory for `server.log`. Omit to log to stderr only. */
  dir?: string;
  retentionDays?: number;
  level?: LogLevel;
  /** Mirror records at or above this level to stderr. */
  stderr?: LogLevel | "off";
}

export interface ServerLog {
  logger: Logger;
  file?: DailyRotatingFile;
}

export function createLogger(opts: CreateLoggerOptions = {}): ServerLog {
  const state = { level: opts.level ?? "info" };
  if (!opts.dir) {
    return { logger: new JsonLogger([], state, {}, opts.stderr ?? "debug") };
  }
  const file = new DailyRotatingFile({
    dir: opts.dir,
    base: "server",
    ext: ".log",
    retentionDays: opts.retentionDays ?? 14,
  });
  return {
    logger: new JsonLogger(
      [{ write: (line) => file.write(line) }],
      state,
      {},
      opts.stderr ?? "warn",
    ),
    file,
  };
}

/** Logger that drops everything; handy in tests. */
export function nullLogger(): Logger {
  return new JsonLogger([], { level: "error" }, {}, "off");
}

/** Logger that keeps records in memory; handy in tests. */
export function memoryLogger(): { logger: Logger; records: LogFields[] } {
  const records: LogFields[] = [];
  const logger = new JsonLogger(
    [{ write: (line) => records.push(JSON.parse(line) as LogFields) }],
    { level: "debug" },
    {},
    "off",
  );
  return { logger, records };
}
