import { DailyRotatingFile } from "./rotating-file";

/**
 * One audit record per tool call (two for sends: before and after the `send` call).
 *
 * Reads carry chat ids and row counts, never message text. Sends carry the recipient
 * and full text, because the point of the log is to show exactly what was sent.
 */
export interface AuditRecord {
  time?: string;
  /** Correlates the before/after records of one send. */
  request_id?: string;
  identity: string;
  identity_kind: string;
  tool: string;
  /** `ok`, `error`, `refused`, `pending`, `sent`, `handed_off_unconfirmed`, `failed`. */
  status: string;
  phase?: "before" | "after" | "retry";
  duration_ms?: number;
  chat_ids?: number[];
  rows?: number;
  recipient?: { to?: string; chat_id?: number };
  text?: string;
  rule?: string;
  cursor?: number | null;
  error?: string;
  [key: string]: unknown;
}

export interface AuditLog {
  record(entry: AuditRecord, durable?: boolean): void;
  close(): void;
}

export class FileAuditLog implements AuditLog {
  private readonly file: DailyRotatingFile;

  constructor(dir: string, retentionDays = 90) {
    this.file = new DailyRotatingFile({ dir, base: "audit", ext: ".jsonl", retentionDays });
  }

  setRetentionDays(days: number): void {
    this.file.setRetentionDays(days);
  }

  record(entry: AuditRecord, durable = false): void {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    this.file.write(line, durable);
  }

  close(): void {
    this.file.close();
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly records: AuditRecord[] = [];
  record(entry: AuditRecord): void {
    this.records.push({ time: new Date().toISOString(), ...entry });
  }
  close(): void {}
}
