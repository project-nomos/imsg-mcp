import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "./version";

/** A Cloudflare Access service token. */
export interface ServiceToken {
  id: string;
  secret: string;
}

export interface AcceptanceOptions {
  /** People hostname, e.g. https://imsg.example.com/mcp (Managed OAuth). */
  publicUrl?: string;
  /** Machine hostname, e.g. https://imsg-agent.example.com/mcp (service tokens). */
  agentUrl?: string;
  /** A token mapped to the `read` role. */
  readToken?: ServiceToken;
  /** A token mapped to `read_send` (optional). */
  sendToken?: ServiceToken;
  /** On the Mac itself: the origin's MCP URL (must answer 403 without a JWT). */
  localMcpUrl?: string;
  /** On the Mac itself: the health URL. */
  healthUrl?: string;
  /** Try a send to a number that must not be on the allowlist, and expect a refusal. */
  refusalTest?: boolean;
  /** Recipient for the refusal test. Must not be on send.allowlist. */
  refusalRecipient?: string;
  fetch?: typeof fetch;
}

type Status = "PASS" | "FAIL" | "SKIP" | "INFO";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "imsg-mcp-acceptance", version: VERSION },
  },
};

function tokenHeaders(token: ServiceToken): Record<string, string> {
  return { "CF-Access-Client-Id": token.id, "CF-Access-Client-Secret": token.secret };
}

async function connect(url: string, token: ServiceToken, fetchImpl: typeof fetch): Promise<Client> {
  const client = new Client({ name: "imsg-mcp-acceptance", version: VERSION });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: tokenHeaders(token) },
      fetch: fetchImpl,
    }),
  );
  return client;
}

function text(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

/**
 * Runs the automatable parts of the acceptance checklist against a deployed server and
 * prints PASS, FAIL or SKIP for each. Returns true when nothing failed. The checks that
 * need a person (a phone on cellular, approval prompts, the power-pull test) are listed
 * at the end.
 */
export async function runAcceptance(
  opts: AcceptanceOptions,
  out: (line: string) => void,
): Promise<boolean> {
  const fetchImpl = opts.fetch ?? fetch;
  let failed = 0;
  const report = (status: Status, check: string, detail = "") => {
    if (status === "FAIL") failed += 1;
    out(`  ${status.padEnd(4)}  ${check}${detail ? `: ${detail}` : ""}`);
  };
  const attempt = async (check: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      report("FAIL", check, err instanceof Error ? err.message : String(err));
    }
  };

  out("imsg-mcp acceptance checks");

  // 1. Unauthenticated requests stop at Cloudflare Access with an OAuth challenge.
  if (opts.publicUrl) {
    await attempt("people hostname answers 401 with WWW-Authenticate", async () => {
      const res = await fetchImpl(opts.publicUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(INITIALIZE),
        redirect: "manual",
      });
      const challenge = res.headers.get("www-authenticate");
      if (res.status === 401 && challenge)
        report("PASS", "people hostname answers 401 with WWW-Authenticate");
      else if (res.status === 302 || res.status === 303) {
        report(
          "FAIL",
          "people hostname answers 401 with WWW-Authenticate",
          `got ${res.status} redirect: turn on Managed OAuth for the Access application`,
        );
      } else {
        report(
          "FAIL",
          "people hostname answers 401 with WWW-Authenticate",
          `got ${res.status}${challenge ? "" : " without WWW-Authenticate"}`,
        );
      }
    });
  } else {
    report("SKIP", "people hostname answers 401", "pass --public-url");
  }

  // 2. The origin itself refuses requests without a valid Access JWT.
  if (opts.localMcpUrl) {
    await attempt("origin answers 403 without a JWT", async () => {
      const res = await fetchImpl(opts.localMcpUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Cf-Access-Authenticated-User-Email": "forged@example.com",
        },
        body: JSON.stringify(INITIALIZE),
      });
      if (res.status === 403)
        report("PASS", "origin answers 403 without a JWT (forged email header ignored)");
      else report("FAIL", "origin answers 403 without a JWT", `got ${res.status}`);
    });
  } else {
    report("SKIP", "origin answers 403 without a JWT", "run on the Mac with --local");
  }

  // 3. Health.
  if (opts.healthUrl) {
    await attempt("health endpoint", async () => {
      const res = await fetchImpl(opts.healthUrl!);
      const body = (await res.json()) as {
        healthy?: boolean;
        problems?: string[];
        heartbeat?: { configured?: boolean };
      };
      if (res.status === 200 && body.healthy) report("PASS", "/healthz reports healthy");
      else
        report(
          "FAIL",
          "/healthz reports healthy",
          (body.problems ?? []).join("; ") || `status ${res.status}`,
        );
      if (body.heartbeat && !body.heartbeat.configured)
        report("INFO", "heartbeat.url is not set; nobody is alerted if the Mac goes quiet");
    });
  } else {
    report("SKIP", "/healthz reports healthy", "run on the Mac with --local");
  }

  // 4. A read token: reads work quickly, and send_message is not offered.
  if (opts.agentUrl && opts.readToken) {
    await attempt("read token", async () => {
      const client = await connect(opts.agentUrl!, opts.readToken!, fetchImpl);
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        if (names.includes("send_message"))
          report("FAIL", "a read token cannot see send_message", "it is listed");
        else report("PASS", "a read token cannot see send_message");
        const started = Date.now();
        const res = await client.callTool({ name: "check_new_messages", arguments: {} });
        const ms = Date.now() - started;
        if (res.isError)
          report(
            "FAIL",
            "check_new_messages through the machine hostname",
            text(res).slice(0, 200),
          );
        else {
          const body = JSON.parse(text(res)) as {
            messages?: unknown[];
            untrusted_content?: boolean;
          };
          report(
            ms < 5000 ? "PASS" : "FAIL",
            "check_new_messages answers in under 5 s",
            `${ms} ms, ${body.messages?.length ?? 0} message(s)`,
          );
          if (body.untrusted_content !== true)
            report("FAIL", "results are flagged untrusted_content");
        }
        const status = JSON.parse(
          text(await client.callTool({ name: "get_status", arguments: {} })),
        ) as {
          watch?: { healthy?: boolean };
          send?: { enabled?: boolean; allowlist_size?: number };
        };
        report(status.watch?.healthy ? "PASS" : "FAIL", "watch is healthy (get_status)");
        report(
          "INFO",
          `sending is ${status.send?.enabled ? "ON" : "off"}, allowlist size ${status.send?.allowlist_size ?? "?"}`,
        );
      } finally {
        await client.close();
      }
    });
  } else {
    report("SKIP", "read token checks", "pass --agent-url and IMSG_ACCEPTANCE_READ_ID / _SECRET");
  }

  // 5. A read_send token: send_message follows send.enabled; the allowlist holds after approval.
  if (opts.agentUrl && opts.sendToken) {
    await attempt("read_send token", async () => {
      const client = await connect(opts.agentUrl!, opts.sendToken!, fetchImpl);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        const status = JSON.parse(
          text(await client.callTool({ name: "get_status", arguments: {} })),
        ) as {
          send?: { enabled?: boolean };
          caller?: { role?: string };
        };
        const enabled = !!status.send?.enabled;
        if (names.includes("send_message") === enabled) {
          report(
            "PASS",
            `send_message is ${enabled ? "listed (send.enabled = true)" : "not listed (send.enabled = false)"}`,
          );
        } else {
          report(
            "FAIL",
            "send_message follows send.enabled",
            `enabled=${enabled}, listed=${names.includes("send_message")}`,
          );
        }
        if (opts.refusalTest && enabled) {
          const to = opts.refusalRecipient ?? "+15550100";
          const res = await client.callTool({
            name: "send_message",
            arguments: { to, text: "imsg-mcp acceptance test: this must be refused" },
          });
          const msg = text(res);
          if (res.isError && msg.includes("rule 2")) {
            report("PASS", `a send to ${to} (not allowlisted) is refused by the server`);
          } else {
            report(
              "FAIL",
              `a send to ${to} (not allowlisted) is refused by the server`,
              msg.slice(0, 200),
            );
          }
        } else if (opts.refusalTest) {
          report("SKIP", "allowlist refusal test", "sending is off");
        }
      } finally {
        await client.close();
      }
    });
  } else {
    report("SKIP", "read_send token checks", "optional: IMSG_ACCEPTANCE_SEND_ID / _SECRET");
  }

  out("");
  out("Still to check by hand (docs/testing.md):");
  out('  [ ] Claude mobile on cellular: "What are my latest texts?" answers in under 5 s');
  out("  [ ] A send asks for approval on every surface and arrives on the recipient's phone");
  out("  [ ] Claude Code signs in through its loopback redirect");
  out(
    "  [ ] Injection test from a second phone; restart test (text during `launchctl kickstart -k`)",
  );
  out("  [ ] Power pulled for 2 minutes: heartbeat back within 10 minutes");
  out(`Result: ${failed ? "FAIL" : "PASS"} (${failed} failed)`);
  return failed === 0;
}
