import { App } from "./app";
import type { ConfigStore } from "./config/store";
import { maskHandle, normalizeHandle } from "./core/handles";
import { ImsgError, permissionHint } from "./imsg/errors";
import type { MessagesApp } from "./imsg/messages-app";
import type { AuditLog } from "./log/audit";
import type { Logger } from "./log/logger";
import { SendRefused } from "./send/rules";
import { SendDisabled } from "./send/service";

export interface SelftestOptions {
  config: ConfigStore;
  logger: Logger;
  audit: AuditLog;
  stateDbPath: string;
  /** Handle to text; defaults to selftest.to. */
  to?: string;
  send: boolean;
  waitForReply: boolean;
  replyTimeoutSeconds?: number;
  out: (line: string) => void;
  imsgCommand?: string[];
  imsgEnv?: NodeJS.ProcessEnv;
  messagesApp?: MessagesApp;
  sleep?: (ms: number) => Promise<void>;
}

type StepStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

/**
 * `imsg-mcp selftest`: the smoke test to run after every imsg, server or macOS update.
 * Reads one chat (Full Disk Access), sends to an allowlisted test handle (Automation),
 * waits for the reply to arrive through the watch stream, and prints pass or fail per step.
 */
export async function runSelftest(opts: SelftestOptions): Promise<boolean> {
  const results: { step: string; status: StepStatus }[] = [];
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const report = (step: string, status: StepStatus, detail = "") => {
    results.push({ step, status });
    opts.out(`  ${status.padEnd(4)}  ${step.padEnd(22)} ${detail}`);
  };
  const failText = (err: unknown) =>
    err instanceof ImsgError && err.kind === "permission"
      ? permissionHint(process.execPath)
      : err instanceof Error
        ? err.message
        : String(err);

  opts.out("imsg-mcp selftest");
  report("config", "PASS", opts.config.path);

  let app: App;
  try {
    app = await App.create({
      config: opts.config,
      logger: opts.logger,
      audit: opts.audit,
      stateDbPath: opts.stateDbPath,
      imsgCommand: opts.imsgCommand,
      imsgEnv: opts.imsgEnv,
      messagesApp: opts.messagesApp,
      mode: "selftest",
      sleep: opts.sleep,
    });
    report(
      "imsg status",
      "PASS",
      `imsg ${app.status.version}, ${app.status.rpcMethods.size} RPC methods`,
    );
  } catch (err) {
    report("imsg status", "FAIL", failText(err));
    return summarize(results, opts.out);
  }

  try {
    app.rpc.start();
    let firstChat: number | undefined;
    try {
      const chats = await app.chats.list(5);
      firstChat = chats[0]?.chat_id;
      report("read chats", "PASS", `${chats.length} chats (Full Disk Access OK)`);
    } catch (err) {
      report("read chats", "FAIL", failText(err));
      return summarize(results, opts.out);
    }

    if (firstChat === undefined) {
      report("read history", "SKIP", "no chats yet");
    } else {
      try {
        const msgs = await app.api.history({ chat_id: firstChat, limit: 1 });
        report("read history", "PASS", `chat ${firstChat}, ${msgs.length} message(s)`);
      } catch (err) {
        report("read history", "FAIL", failText(err));
      }
    }

    const cursorBefore = app.store.getCursor();
    app.watcher.start();
    await app.watcher.ensureSubscribed("selftest");
    if (app.watcher.subscribed) {
      report("watch", "PASS", `subscribed (cursor ${app.store.getCursor() || "tail"})`);
    } else {
      report("watch", "FAIL", app.watcher.lastError ?? "could not subscribe");
    }

    const cfg = opts.config.current;
    const to = opts.to ?? cfg.selftest.to;
    if (!opts.send) {
      report("send", "SKIP", "--no-send");
      report("reply via watch", "SKIP", "--no-send");
      return summarize(results, opts.out);
    }
    const handle = to ? normalizeHandle(to) : undefined;
    if (!handle) {
      report("send", "SKIP", "no test recipient (set selftest.to or pass --to)");
      report("reply via watch", "SKIP", "nothing sent");
      return summarize(results, opts.out);
    }

    const stamp = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    let sentCursor: number | null = null;
    let sentChat: number | null = null;
    try {
      const outcome = await app.sender.send(
        { kind: "local", id: "selftest", role: "full" },
        { to: handle, text: `imsg-mcp selftest at ${stamp}. Reply with anything to confirm.` },
      );
      sentCursor = outcome.cursor;
      sentChat = outcome.chat_id;
      if (outcome.status === "sent") {
        report(
          "send",
          "PASS",
          `sent to ${maskHandle(handle)} (cursor ${outcome.cursor}, Automation OK)`,
        );
      } else {
        report(
          "send",
          "WARN",
          `handed to Messages but not yet seen in history (${maskHandle(handle)})`,
        );
      }
    } catch (err) {
      // Read-only phase (send.enabled = false) skips; any other refusal is a real failure.
      const skip = err instanceof SendDisabled;
      const detail =
        err instanceof SendRefused && err.rule === "allowlist"
          ? `${failText(err)} (add ${maskHandle(handle)} to send.allowlist)`
          : failText(err);
      report("send", skip ? "SKIP" : "FAIL", detail);
      report("reply via watch", "SKIP", "nothing sent");
      return summarize(results, opts.out);
    }

    if (!opts.waitForReply) {
      report("reply via watch", "SKIP", "--no-wait");
      return summarize(results, opts.out);
    }
    const timeoutS = opts.replyTimeoutSeconds ?? cfg.selftest.reply_timeout_seconds;
    opts.out(`        waiting up to ${timeoutS}s for a reply from ${maskHandle(handle)}…`);
    const startedWait = Date.now();
    const after = Math.max(cursorBefore, sentCursor ?? 0);
    for (;;) {
      const rows = app.store.inboundAfter(after, undefined, 200);
      const reply = rows.find(
        (r) =>
          (sentChat !== null && r.chat_id === sentChat) ||
          normalizeHandle(r.sender ?? "") === handle,
      );
      if (reply) {
        const secs = Math.round((Date.now() - startedWait) / 1000);
        report("reply via watch", "PASS", `reply arrived after ${secs}s (cursor ${reply.rowid})`);
        break;
      }
      if (Date.now() - startedWait > timeoutS * 1000) {
        report("reply via watch", "FAIL", `no reply within ${timeoutS}s`);
        break;
      }
      await sleep(1000);
    }
    return summarize(results, opts.out);
  } finally {
    await app.stop();
  }
}

function summarize(results: { status: StepStatus }[], out: (line: string) => void): boolean {
  const failed = results.filter((r) => r.status === "FAIL").length;
  const passed = results.filter((r) => r.status === "PASS" || r.status === "WARN").length;
  out(
    `Result: ${failed ? "FAIL" : "PASS"} (${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped)`,
  );
  return failed === 0;
}
