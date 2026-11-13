import { z } from "zod";
import { looksLikeNonE164Phone, normalizeHandle } from "../core/handles";
import { parseRate, type RateWindow } from "./rate";

/** Roles a caller can hold. `full` is for people; machines get `read` or `read_send`. */
export type Role = "full" | "read" | "read_send";

export function roleCanSend(role: Role): boolean {
  return role === "full" || role === "read_send";
}

export interface HostPort {
  host: string;
  port: number;
}

export interface AllowlistConfig {
  /** Normalized E.164 numbers and lowercase emails. */
  handles: Set<string>;
  /** Chat rowids. */
  chatIds: Set<number>;
  /** Number of distinct entries. */
  size: number;
}

export type ReadScopeConfig =
  | { mode: "all" }
  | {
      mode: "list";
      chatIds: Set<number>;
      handles: Set<string>;
      /** Chat identifiers or GUIDs, such as `chat1234` or `iMessage;+;chat1234`. */
      chatKeys: Set<string>;
      size: number;
    };

export interface Config {
  server: { listen: HostPort; health_listen: HostPort };
  imsg: {
    path: string;
    db: string | undefined;
    call_timeout_ms: number;
    /** Restart backoff bounds for the `imsg rpc` child. */
    restart_initial_ms: number;
    restart_max_ms: number;
  };
  send: {
    enabled: boolean;
    allowlist: AllowlistConfig;
    max_chars: number;
    rate: RateWindow[];
    rate_spec: string;
    confirm_timeout_ms: number;
  };
  read: { scope: ReadScopeConfig; max_text_chars: number; max_result_chars: number };
  access: {
    team_domain: string | undefined;
    aud: string[];
    people: string[];
    service_tokens: Record<string, "read" | "read_send">;
    clock_tolerance_seconds: number;
  };
  store: { retention_days: number };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    server_retention_days: number;
    audit_retention_days: number;
  };
  heartbeat: { url: string | undefined; interval_seconds: number };
  health: {
    sync_check_interval_seconds: number;
    messages_check_interval_seconds: number;
    relaunch_messages: boolean;
  };
  local: { role: Role };
  selftest: { to: string | undefined; reply_timeout_seconds: number };
}

const chatIdOrHandle = z.union([z.number(), z.string()]);

const RawConfigSchema = z.strictObject({
  server: z
    .strictObject({
      listen: z.string().default("127.0.0.1:8787"),
      health_listen: z.string().default("127.0.0.1:8788"),
    })
    .prefault({}),
  imsg: z
    .strictObject({
      path: z.string().min(1).default("imsg"),
      db: z.string().default(""),
      call_timeout_ms: z.number().int().min(1000).max(120_000).default(10_000),
      restart_initial_ms: z.number().int().min(100).max(60_000).default(1_000),
      restart_max_ms: z.number().int().min(100).max(600_000).default(30_000),
    })
    .prefault({}),
  send: z
    .strictObject({
      enabled: z.boolean().default(false),
      allowlist: z.array(chatIdOrHandle).default([]),
      max_chars: z.number().int().min(1).max(20_000).default(1000),
      rate: z.string().default("10/hour, 40/day"),
      confirm_timeout_ms: z.number().int().min(0).max(60_000).default(10_000),
    })
    .prefault({}),
  read: z
    .strictObject({
      scope: z.union([z.literal("all"), z.array(chatIdOrHandle)]).default("all"),
      max_text_chars: z.number().int().min(100).max(100_000).default(4000),
      // Claude accepts about 150,000 characters per tool result (25,000 tokens in Claude Code).
      max_result_chars: z.number().int().min(5_000).max(1_000_000).default(60_000),
    })
    .prefault({}),
  access: z
    .strictObject({
      team_domain: z.string().default(""),
      aud: z.union([z.string(), z.array(z.string())]).default([]),
      people: z.array(z.string()).default([]),
      service_tokens: z.record(z.string(), z.enum(["read", "read_send"])).default({}),
      clock_tolerance_seconds: z.number().int().min(0).max(300).default(10),
    })
    .prefault({}),
  store: z
    .strictObject({
      retention_days: z.number().int().min(1).max(365).default(14),
    })
    .prefault({}),
  logging: z
    .strictObject({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
      server_retention_days: z.number().int().min(1).max(365).default(14),
      audit_retention_days: z.number().int().min(1).max(3650).default(90),
    })
    .prefault({}),
  heartbeat: z
    .strictObject({
      url: z.string().default(""),
      interval_seconds: z.number().int().min(30).max(86_400).default(300),
    })
    .prefault({}),
  health: z
    .strictObject({
      sync_check_interval_seconds: z.number().int().min(30).max(86_400).default(600),
      messages_check_interval_seconds: z.number().int().min(10).max(3600).default(60),
      relaunch_messages: z.boolean().default(true),
    })
    .prefault({}),
  local: z
    .strictObject({
      role: z.enum(["full", "read", "read_send"]).default("full"),
    })
    .prefault({}),
  selftest: z
    .strictObject({
      to: z.string().default(""),
      reply_timeout_seconds: z.number().int().min(5).max(3600).default(120),
    })
    .prefault({}),
});

export type RawConfig = z.infer<typeof RawConfigSchema>;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function parseHostPort(value: string, key: string, problems: string[]): HostPort {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(value.trim());
  if (!m) {
    problems.push(`${key} "${value}" should be host:port, e.g. 127.0.0.1:8787`);
    return { host: "127.0.0.1", port: 0 };
  }
  const host = m[1] ?? "";
  const port = Number(m[2]);
  if (!LOOPBACK_HOSTS.has(host)) {
    problems.push(
      `${key} must bind to loopback (127.0.0.1, ::1 or localhost), not "${host}"; ` +
        `only cloudflared on the same machine should reach the server`,
    );
  }
  if (port < 0 || port > 65535) problems.push(`${key} port ${port} is out of range`);
  return { host, port };
}

/** A chat id written as a number or a string of digits. Long digit strings are phone mistakes. */
function asChatId(entry: string | number): number | undefined {
  if (typeof entry === "number") {
    // More than 9 digits is a phone number written without quotes, not a chat rowid.
    return Number.isSafeInteger(entry) && entry > 0 && entry < 1_000_000_000 ? entry : Number.NaN;
  }
  const s = entry.trim();
  if (/^\d{1,9}$/.test(s)) return Number(s);
  return undefined;
}

function normalizeTeamDomain(raw: string): string | undefined {
  const s = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return s || undefined;
}

/** Validates raw TOML data and derives the runtime config. Throws ConfigError. */
export function buildConfig(data: unknown): Config {
  const parsed = RawConfigSchema.safeParse(data ?? {});
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.join(".") || "(root)";
        if (issue.code === "unrecognized_keys") {
          return `${path ? `${path}: ` : ""}unknown key(s) ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
        }
        return `${path}: ${issue.message}`;
      }),
    );
  }
  const raw = parsed.data;
  const problems: string[] = [];

  const listen = parseHostPort(raw.server.listen, "server.listen", problems);
  const healthListen = parseHostPort(raw.server.health_listen, "server.health_listen", problems);
  if (listen.port !== 0 && listen.port === healthListen.port && listen.host === healthListen.host) {
    problems.push("server.listen and server.health_listen must use different ports");
  }

  // send.allowlist: E.164 numbers, emails, or chat ids.
  const allowHandles = new Set<string>();
  const allowChats = new Set<number>();
  for (const entry of raw.send.allowlist) {
    const chatId = asChatId(entry);
    if (chatId !== undefined) {
      if (Number.isNaN(chatId)) {
        problems.push(
          `send.allowlist: ${entry} is not a valid chat id (write phone numbers as quoted E.164 strings, like "+14155550123")`,
        );
      } else allowChats.add(chatId);
      continue;
    }
    const handle = normalizeHandle(String(entry));
    if (!handle) {
      problems.push(
        `send.allowlist: "${entry}" is not an E.164 number (like +14155550123), an email, or a chat id`,
      );
      continue;
    }
    allowHandles.add(handle);
  }

  // read.scope: "all", or chat ids, handles, and chat identifiers/GUIDs.
  let scope: ReadScopeConfig = { mode: "all" };
  if (raw.read.scope !== "all") {
    const chatIds = new Set<number>();
    const handles = new Set<string>();
    const chatKeys = new Set<string>();
    for (const entry of raw.read.scope) {
      const chatId = asChatId(entry);
      if (chatId !== undefined) {
        if (Number.isNaN(chatId)) {
          problems.push(
            `read.scope: ${entry} is not a valid chat id (write phone numbers as quoted E.164 strings, like "+14155550123")`,
          );
        } else chatIds.add(chatId);
        continue;
      }
      const s = String(entry).trim();
      if (!s) {
        problems.push("read.scope: empty entry");
        continue;
      }
      const handle = normalizeHandle(s);
      if (handle) {
        handles.add(handle);
      } else if (looksLikeNonE164Phone(s)) {
        problems.push(`read.scope: "${s}" looks like a phone number; write it in E.164 form`);
      } else {
        chatKeys.add(s);
      }
    }
    scope = {
      mode: "list",
      chatIds,
      handles,
      chatKeys,
      size: chatIds.size + handles.size + chatKeys.size,
    };
  }

  let rate: RateWindow[] = [];
  try {
    rate = parseRate(raw.send.rate);
  } catch (err) {
    problems.push(`send.rate: ${(err as Error).message}`);
  }

  const people: string[] = [];
  for (const email of raw.access.people) {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(e)) problems.push(`access.people: "${email}" is not an email`);
    else people.push(e);
  }
  const aud = (Array.isArray(raw.access.aud) ? raw.access.aud : [raw.access.aud])
    .map((a) => a.trim())
    .filter(Boolean);
  const teamDomain = normalizeTeamDomain(raw.access.team_domain);
  if (teamDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(teamDomain)) {
    problems.push(`access.team_domain "${raw.access.team_domain}" is not a hostname`);
  }

  let heartbeatUrl: string | undefined;
  if (raw.heartbeat.url.trim()) {
    try {
      const u = new URL(raw.heartbeat.url.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad protocol");
      heartbeatUrl = u.toString();
    } catch {
      problems.push(`heartbeat.url "${raw.heartbeat.url}" is not an http(s) URL`);
    }
  }

  let selftestTo: string | undefined;
  if (raw.selftest.to.trim()) {
    selftestTo = normalizeHandle(raw.selftest.to);
    if (!selftestTo)
      problems.push(`selftest.to "${raw.selftest.to}" is not an E.164 number or email`);
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    server: { listen, health_listen: healthListen },
    imsg: {
      path: raw.imsg.path,
      db: raw.imsg.db.trim() || undefined,
      call_timeout_ms: raw.imsg.call_timeout_ms,
      restart_initial_ms: raw.imsg.restart_initial_ms,
      restart_max_ms: Math.max(raw.imsg.restart_max_ms, raw.imsg.restart_initial_ms),
    },
    send: {
      enabled: raw.send.enabled,
      allowlist: {
        handles: allowHandles,
        chatIds: allowChats,
        size: allowHandles.size + allowChats.size,
      },
      max_chars: raw.send.max_chars,
      rate,
      rate_spec: raw.send.rate,
      confirm_timeout_ms: raw.send.confirm_timeout_ms,
    },
    read: {
      scope,
      max_text_chars: raw.read.max_text_chars,
      max_result_chars: raw.read.max_result_chars,
    },
    access: {
      team_domain: teamDomain,
      aud,
      people,
      service_tokens: raw.access.service_tokens,
      clock_tolerance_seconds: raw.access.clock_tolerance_seconds,
    },
    store: { retention_days: raw.store.retention_days },
    logging: raw.logging,
    heartbeat: { url: heartbeatUrl, interval_seconds: raw.heartbeat.interval_seconds },
    health: raw.health,
    local: { role: raw.local.role },
    selftest: { to: selftestTo, reply_timeout_seconds: raw.selftest.reply_timeout_seconds },
  };
}

/** Problems that make the HTTP (remote) mode unusable. Stdio mode does not need these. */
export function remoteModeProblems(cfg: Config): string[] {
  const problems: string[] = [];
  if (!cfg.access.team_domain) {
    problems.push("access.team_domain is required (e.g. myteam.cloudflareaccess.com)");
  }
  if (cfg.access.aud.length === 0) {
    problems.push("access.aud must list the AUD tag of each Cloudflare Access application");
  }
  if (cfg.access.people.length === 0 && Object.keys(cfg.access.service_tokens).length === 0) {
    problems.push("access.people or access.service_tokens must name at least one caller");
  }
  return problems;
}

/** Non-fatal warnings worth printing at startup and in `check-config`. */
export function configWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  if (cfg.send.enabled && cfg.send.allowlist.size === 0) {
    warnings.push(
      "send.enabled is true but send.allowlist is empty, so every send will be refused",
    );
  }
  if (cfg.read.scope.mode === "list" && cfg.read.scope.size === 0) {
    warnings.push("read.scope is an empty list, so no chat can be read");
  }
  if (!cfg.heartbeat.url) {
    warnings.push("heartbeat.url is not set, so nobody is alerted if this Mac goes quiet");
  }
  return warnings;
}
