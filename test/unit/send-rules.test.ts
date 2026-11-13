import { describe, expect, test } from "bun:test";
import { buildConfig } from "../../src/config/schema";
import { RateLimiter } from "../../src/send/rate-limiter";
import {
  checkAllowlistChat,
  checkAllowlistHandle,
  checkLength,
  checkRole,
  SendRefused,
} from "../../src/send/rules";
import { StateDb } from "../../src/store/state-db";
import { parseRate } from "../../src/config/rate";

const allowlist = buildConfig({
  send: { allowlist: ["+14155550101", "Carol@Example.com", 3] },
}).send.allowlist;

function rule(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SendRefused);
    return (err as SendRefused).rule;
  }
  return "passed";
}

describe("rule 1: role", () => {
  test("read cannot send; full and read_send can", () => {
    expect(rule(() => checkRole("read"))).toBe("role");
    expect(rule(() => checkRole("full"))).toBe("passed");
    expect(rule(() => checkRole("read_send"))).toBe("passed");
  });
});

describe("rule 2: allowlist", () => {
  test("listed handles pass, in any common format", () => {
    expect(checkAllowlistHandle("+14155550101", allowlist)).toBe("+14155550101");
    expect(checkAllowlistHandle("+1 (415) 555-0101", allowlist)).toBe("+14155550101");
    expect(checkAllowlistHandle("carol@example.com", allowlist)).toBe("carol@example.com");
    expect(checkAllowlistHandle("CAROL@EXAMPLE.COM", allowlist)).toBe("carol@example.com");
  });

  test("unlisted and malformed recipients are refused", () => {
    expect(rule(() => checkAllowlistHandle("+14155550199", allowlist))).toBe("allowlist");
    expect(rule(() => checkAllowlistHandle("+1 555 0100", allowlist))).toBe("allowlist");
    expect(rule(() => checkAllowlistHandle("4155550101", allowlist))).toBe("allowlist");
    expect(rule(() => checkAllowlistHandle("Alice", allowlist))).toBe("allowlist");
  });

  test("a chat passes when its id is listed or every participant is", () => {
    expect(rule(() => checkAllowlistChat(3, ["+14155550199"], allowlist))).toBe("passed");
    expect(
      rule(() => checkAllowlistChat(9, ["+14155550101", "carol@example.com"], allowlist)),
    ).toBe("passed");
  });

  test("a chat with one unlisted member is refused", () => {
    expect(rule(() => checkAllowlistChat(9, ["+14155550101", "+14155550199"], allowlist))).toBe(
      "allowlist",
    );
    expect(rule(() => checkAllowlistChat(9, [], allowlist))).toBe("allowlist");
    expect(rule(() => checkAllowlistChat(9, ["12345"], allowlist))).toBe("allowlist");
  });
});

describe("rule 3: length", () => {
  test("trims and enforces 1..max characters", () => {
    expect(checkLength("  hi  ", 10)).toBe("hi");
    expect(rule(() => checkLength("   ", 10))).toBe("length");
    expect(rule(() => checkLength("", 10))).toBe("length");
    expect(checkLength("x".repeat(10), 10)).toHaveLength(10);
    expect(rule(() => checkLength("x".repeat(11), 10))).toBe("length");
  });

  test("counts characters, not UTF-16 units", () => {
    expect(checkLength("😀".repeat(10), 10)).toBe("😀".repeat(10));
    expect(rule(() => checkLength("😀".repeat(11), 10))).toBe("length");
  });
});

describe("rule 4: rate limit", () => {
  test("sliding windows across clients, persisted in state.db", () => {
    let now = 1_000_000_000;
    const store = new StateDb(":memory:", () => now);
    const limiter = new RateLimiter(store, () => now);
    const windows = parseRate("2/hour, 3/day");

    expect(limiter.tryAcquire(windows, "a").ok).toBe(true);
    now += 1000;
    expect(limiter.tryAcquire(windows, "b").ok).toBe(true);
    now += 1000;
    const third = limiter.tryAcquire(windows, "a");
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.full.window).toBe("2/hour");
      expect(third.full.next_slot_at).toBe(new Date(1_000_000_000 + 3_600_000).toISOString());
    }
    expect(limiter.remaining(windows)).toBe(0);

    // An hour later the hourly window has room, but the daily one allows one more.
    now += 3_600_000;
    expect(limiter.tryAcquire(windows, "a").ok).toBe(true);
    const daily = limiter.tryAcquire(windows, "a");
    expect(daily.ok).toBe(false);
    if (!daily.ok) expect(daily.full.window).toBe("3/day");

    // A new limiter on the same store sees the same history (a restart does not reset it).
    const again = new RateLimiter(store, () => now);
    expect(again.budget(windows).map((b) => b.used)).toEqual([1, 3]);
  });
});
