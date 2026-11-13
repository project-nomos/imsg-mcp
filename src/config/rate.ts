export interface RateWindow {
  /** Maximum sends inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Human label, e.g. `hour`. */
  unit: string;
}

const UNITS: Record<string, { ms: number; label: string }> = {
  s: { ms: 1_000, label: "second" },
  sec: { ms: 1_000, label: "second" },
  secs: { ms: 1_000, label: "second" },
  second: { ms: 1_000, label: "second" },
  seconds: { ms: 1_000, label: "second" },
  m: { ms: 60_000, label: "minute" },
  min: { ms: 60_000, label: "minute" },
  mins: { ms: 60_000, label: "minute" },
  minute: { ms: 60_000, label: "minute" },
  minutes: { ms: 60_000, label: "minute" },
  h: { ms: 3_600_000, label: "hour" },
  hr: { ms: 3_600_000, label: "hour" },
  hrs: { ms: 3_600_000, label: "hour" },
  hour: { ms: 3_600_000, label: "hour" },
  hours: { ms: 3_600_000, label: "hour" },
  d: { ms: 86_400_000, label: "day" },
  day: { ms: 86_400_000, label: "day" },
  days: { ms: 86_400_000, label: "day" },
};

/**
 * Parses a rate spec such as `10/hour, 40/day` into sliding windows.
 * Throws with a readable message on anything it does not understand.
 */
export function parseRate(spec: string): RateWindow[] {
  const parts = spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error(`rate "${spec}" is empty`);
  const windows: RateWindow[] = [];
  for (const part of parts) {
    const m = /^(\d+)\s*\/\s*(\d+)?\s*([a-z]+)$/i.exec(part);
    if (!m) throw new Error(`rate part "${part}" should look like "10/hour"`);
    const limit = Number(m[1]);
    const multiplier = m[2] ? Number(m[2]) : 1;
    const unit = UNITS[(m[3] ?? "").toLowerCase()];
    if (!unit) throw new Error(`rate part "${part}" has an unknown unit "${m[3]}"`);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`rate part "${part}" needs a limit of at least 1`);
    }
    if (multiplier < 1) throw new Error(`rate part "${part}" needs a window of at least 1`);
    windows.push({
      limit,
      windowMs: unit.ms * multiplier,
      unit: multiplier === 1 ? unit.label : `${multiplier} ${unit.label}s`,
    });
  }
  return windows;
}

export function formatRate(windows: RateWindow[]): string {
  return windows.map((w) => `${w.limit}/${w.unit}`).join(", ");
}
