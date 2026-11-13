import type { RateWindow } from "../config/rate";
import type { StateDb } from "../store/state-db";

export interface RateBudget {
  window: string;
  limit: number;
  used: number;
  remaining: number;
  /** When the oldest send in a full window ages out. */
  next_slot_at: string | null;
}

/**
 * Sliding-window send limits shared by every client. Send times live in `state.db`,
 * so restarting the server does not reset the budget.
 */
export class RateLimiter {
  constructor(
    private readonly store: StateDb,
    private readonly now: () => number = Date.now,
  ) {}

  budget(windows: RateWindow[]): RateBudget[] {
    const now = this.now();
    const longest = Math.max(0, ...windows.map((w) => w.windowMs));
    const times = this.store.sendTimesSince(now - longest);
    return windows.map((w) => {
      const inWindow = times.filter((t) => t > now - w.windowMs);
      const remaining = Math.max(0, w.limit - inWindow.length);
      const oldest = inWindow[0];
      return {
        window: `${w.limit}/${w.unit}`,
        limit: w.limit,
        used: inWindow.length,
        remaining,
        next_slot_at:
          remaining === 0 && oldest !== undefined
            ? new Date(oldest + w.windowMs).toISOString()
            : null,
      };
    });
  }

  /** Smallest remaining count across all windows. */
  remaining(windows: RateWindow[]): number {
    const budget = this.budget(windows);
    return budget.length ? Math.min(...budget.map((b) => b.remaining)) : Number.POSITIVE_INFINITY;
  }

  /**
   * Takes a slot if every window has room. Check and record happen together, so
   * concurrent sends cannot both squeeze into the last slot.
   */
  tryAcquire(
    windows: RateWindow[],
    identity: string,
  ): { ok: true } | { ok: false; full: RateBudget } {
    const full = this.budget(windows).find((b) => b.remaining <= 0);
    if (full) return { ok: false, full };
    this.store.recordSend(this.now(), identity);
    return { ok: true };
  }
}
