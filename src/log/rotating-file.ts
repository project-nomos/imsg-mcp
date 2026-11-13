import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Local calendar date as YYYY-MM-DD. Rotation follows the Mac's local day. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface RotatingFileOptions {
  dir: string;
  /** File name without extension, e.g. `server` or `audit`. */
  base: string;
  /** Extension including the dot, e.g. `.log` or `.jsonl`. */
  ext: string;
  /** Rotated files older than this many days are deleted. */
  retentionDays: number;
  now?: () => number;
}

/**
 * Append-only file that rotates once per local day.
 *
 * The active file is always `<base><ext>`. When the day changes, it is renamed to
 * `<base>.<YYYY-MM-DD><ext>` (the day it covers) and a fresh file is started. Files
 * past the retention window are deleted at each rotation and at startup.
 *
 * Writes are synchronous so a crash never loses a line that was reported as written;
 * `durable: true` additionally fsyncs, which the audit log uses around sends.
 */
export class DailyRotatingFile {
  private fd: number | undefined;
  private activeDay: string | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: RotatingFileOptions) {
    this.now = opts.now ?? Date.now;
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    this.prune();
  }

  get path(): string {
    return join(this.opts.dir, `${this.opts.base}${this.opts.ext}`);
  }

  setRetentionDays(days: number): void {
    this.opts.retentionDays = days;
  }

  write(line: string, durable = false): void {
    this.ensureOpen();
    const data = line.endsWith("\n") ? line : `${line}\n`;
    writeSync(this.fd!, data);
    if (durable) fsyncSync(this.fd!);
  }

  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }

  private ensureOpen(): void {
    const today = localDate(this.now());
    if (this.fd !== undefined && this.activeDay === today) return;

    if (this.fd === undefined && existsSync(this.path)) {
      // Pick up the day of an existing file left by a previous run.
      this.activeDay = localDate(statSync(this.path).mtimeMs);
    }
    if (this.activeDay !== undefined && this.activeDay !== today && existsSync(this.path)) {
      this.close();
      const rotated = join(this.opts.dir, `${this.opts.base}.${this.activeDay}${this.opts.ext}`);
      if (!existsSync(rotated)) renameSync(this.path, rotated);
      this.prune();
    }
    if (this.fd === undefined) {
      this.fd = openSync(this.path, "a", 0o600);
    }
    this.activeDay = today;
  }

  /** Deletes rotated files whose date is older than the retention window. */
  prune(): void {
    const cutoff = localDate(this.now() - this.opts.retentionDays * 86_400_000);
    const prefix = `${this.opts.base}.`;
    let names: string[];
    try {
      names = readdirSync(this.opts.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(this.opts.ext)) continue;
      const day = name.slice(prefix.length, name.length - this.opts.ext.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (day < cutoff) {
        try {
          unlinkSync(join(this.opts.dir, name));
        } catch {
          // Best effort; the next rotation tries again.
        }
      }
    }
  }
}
