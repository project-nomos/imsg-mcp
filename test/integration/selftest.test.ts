import { afterEach, describe, expect, test } from "bun:test";
import { buildConfig } from "../../src/config/schema";
import { ConfigStore } from "../../src/config/store";
import { runSelftest } from "../../src/selftest";
import { ALICE } from "../helpers/fixtures";
import { baseConfig, Harness, STUB } from "../helpers/harness";

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.stop()));
});

async function selftest(
  config: Record<string, unknown>,
  behavior: Record<string, unknown>,
  opts: { send?: boolean; wait?: boolean; to?: string; replyTimeoutSeconds?: number } = {},
) {
  const h = new Harness({ start: false });
  harnesses.push(h);
  h.setBehavior(behavior);
  await h.start();
  const lines: string[] = [];
  const ok = await runSelftest({
    config: new ConfigStore(h.config.path, buildConfig(baseConfig(config))),
    logger: h.log.logger,
    audit: h.audit,
    stateDbPath: h.statePath,
    to: opts.to,
    send: opts.send ?? true,
    waitForReply: opts.wait ?? true,
    replyTimeoutSeconds: opts.replyTimeoutSeconds ?? 5,
    out: (l) => lines.push(l),
    imsgCommand: [process.execPath, STUB],
    imsgEnv: h.env,
    messagesApp: h.messagesApp,
    sleep: (ms) => Bun.sleep(Math.min(ms, 100)),
  });
  return { ok, output: lines.join("\n"), h };
}

describe("imsg-mcp selftest", () => {
  test("passes every step when the reply arrives through the watch", async () => {
    const { ok, output, h } = await selftest(
      { selftest: { to: ALICE } },
      { auto_reply: { text: "got it", delay_ms: 300 } },
    );
    expect(output).toContain("PASS  read chats");
    expect(output).toContain("PASS  read history");
    expect(output).toContain("PASS  watch");
    expect(output).toContain("PASS  send");
    expect(output).toContain("PASS  reply via watch");
    expect(output).toContain("Result: PASS");
    expect(ok).toBe(true);
    expect(h.audit.records.some((r) => r.identity === "selftest" && r.status === "sent")).toBe(
      true,
    );
  });

  test("fails when no reply comes back in time", async () => {
    const { ok, output } = await selftest(
      { selftest: { to: ALICE } },
      {},
      { replyTimeoutSeconds: 1 },
    );
    expect(output).toContain("FAIL  reply via watch");
    expect(ok).toBe(false);
  }, 15_000);

  test("skips sending while send.enabled is false (read-only phase)", async () => {
    const { ok, output } = await selftest(
      { send: { enabled: false }, selftest: { to: ALICE } },
      {},
    );
    expect(output).toContain("SKIP  send");
    expect(ok).toBe(true);
  });

  test("fails clearly when the test number is not allowlisted", async () => {
    const { ok, output } = await selftest({}, {}, { to: "+14155550188" });
    expect(output).toContain("FAIL  send");
    expect(output).toContain("add +1415•••0188 to send.allowlist");
    expect(ok).toBe(false);
  });

  test("reports missing Full Disk Access", async () => {
    const { ok, output } = await selftest({}, { permission_denied: true }, { send: false });
    expect(output).toContain("FAIL  read chats");
    expect(output).toContain("Full Disk Access");
    expect(ok).toBe(false);
  });
});
