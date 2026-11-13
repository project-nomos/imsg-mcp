import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FileAuditLog } from "../../src/log/audit";
import { createLogger } from "../../src/log/logger";
import { DailyRotatingFile, localDate } from "../../src/log/rotating-file";
import { tempDir } from "../helpers/harness";

const DAY = 86_400_000;

describe("daily rotating file", () => {
  test("rotates when the local day changes and prunes old files", () => {
    const dir = tempDir();
    let now = new Date(2026, 10, 10, 12, 0, 0).getTime();
    const file = new DailyRotatingFile({
      dir,
      base: "audit",
      ext: ".jsonl",
      retentionDays: 2,
      now: () => now,
    });
    file.write('{"n":1}');
    now += DAY;
    file.write('{"n":2}');
    now += DAY;
    file.write('{"n":3}');
    now += DAY;
    file.write('{"n":4}');
    file.close();

    const names = readdirSync(dir).sort();
    // Day 1's file is older than the 2-day retention and was deleted.
    expect(names).toEqual([
      `audit.${localDate(now - 2 * DAY)}.jsonl`,
      `audit.${localDate(now - DAY)}.jsonl`,
      "audit.jsonl",
    ]);
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toBe('{"n":4}\n');
    expect(statSync(join(dir, "audit.jsonl")).mode & 0o777).toBe(0o600);
  });

  test("rotates a file left over from a previous day at startup", () => {
    const dir = tempDir();
    const path = join(dir, "server.log");
    writeFileSync(path, "old\n");
    const yesterday = new Date(Date.now() - DAY);
    utimesSync(path, yesterday, yesterday);
    const file = new DailyRotatingFile({ dir, base: "server", ext: ".log", retentionDays: 14 });
    file.write("new");
    file.close();
    expect(readFileSync(join(dir, `server.${localDate(yesterday.getTime())}.log`), "utf8")).toBe(
      "old\n",
    );
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });
});

describe("audit and server logs", () => {
  test("audit records are JSON lines with a timestamp", () => {
    const dir = tempDir();
    const audit = new FileAuditLog(dir);
    audit.record({
      identity: "me",
      identity_kind: "person",
      tool: "get_messages",
      status: "ok",
      chat_ids: [1],
      rows: 3,
    });
    audit.record(
      {
        identity: "me",
        identity_kind: "person",
        tool: "send_message",
        status: "pending",
        text: "hi",
      },
      true,
    );
    audit.close();
    const lines = readFileSync(join(dir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].tool).toBe("get_messages");
    expect(typeof lines[0].time).toBe("string");
    expect(lines[1].text).toBe("hi");
  });

  test("the server log respects its level", () => {
    const dir = tempDir();
    const { logger, file } = createLogger({ dir, level: "warn", stderr: "off" });
    logger.info("hidden");
    logger.warn("shown", { n: 1 });
    logger.child({ component: "x" }).error("child", { error: new Error("boom") });
    file?.close();
    const lines = readFileSync(join(dir, "server.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.msg)).toEqual(["shown", "child"]);
    expect(lines[1].component).toBe("x");
    expect(lines[1].error).toEqual({ name: "Error", message: "boom" });
    expect(existsSync(join(dir, "audit.jsonl"))).toBe(false);
  });
});
