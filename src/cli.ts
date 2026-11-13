#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { runAcceptance } from "./acceptance";
import { App, StartupError } from "./app";
import { EXAMPLE_CONFIG } from "./config/example";
import { formatRate } from "./config/rate";
import { ConfigError, configWarnings, remoteModeProblems } from "./config/schema";
import { ConfigStore, configPermissionWarning } from "./config/store";
import { startHealthServer } from "./http/health-http";
import { startMcpHttpServer } from "./http/mcp-http";
import { missingRequiredMethods, readImsgStatus, resolveImsgPath } from "./imsg/status";
import { FileAuditLog } from "./log/audit";
import { createLogger, type Logger } from "./log/logger";
import { serveStdio } from "./mcp/stdio";
import { HealthMonitor } from "./ops/health";
import { runSelftestViaLaunchd } from "./ops/launchd-selftest";
import { defaultPaths, stateDbPath, type Paths } from "./paths";
import { runSelftest } from "./selftest";
import { VERSION } from "./version";

const EX_USAGE = 64;
const EX_UNAVAILABLE = 69;
const EX_CONFIG = 78;

const HELP = `imsg-mcp ${VERSION}: an MCP server for iMessage/SMS on a Mac, built on imsg.

Usage:
  imsg-mcp [serve]          Serve MCP over HTTP on loopback (behind Cloudflare Tunnel + Access)
  imsg-mcp stdio            Serve MCP over stdin/stdout for a local client (no network)
  imsg-mcp selftest         Smoke test: read a chat, send to selftest.to, wait for the reply
                            (add --launchd to test the permissions the service really has)
  imsg-mcp check-config     Validate the config and check imsg
  imsg-mcp acceptance       Run the automatable acceptance checks against a deployment
  imsg-mcp init             Write a starter config (mode 0600)
  imsg-mcp version          Print the version

Options:
  --config <path>     Config file (default: ~/Library/Application Support/imsg-mcp/config.toml)
  --to <handle>       selftest: recipient (overrides selftest.to)
  --no-send           selftest: skip the send and reply steps
  --no-wait           selftest: send but do not wait for a reply
  --timeout <sec>     selftest: how long to wait for the reply
  --launchd           selftest: run as a one-shot LaunchAgent, like the service, so macOS
                      checks imsg-mcp's own Full Disk Access/Automation grants rather than
                      your terminal's
  --force             init: overwrite an existing config
  --public-url <url>  acceptance: people hostname, e.g. https://imsg.example.com/mcp
  --agent-url <url>   acceptance: machine hostname, e.g. https://imsg-agent.example.com/mcp
                      (service tokens from IMSG_ACCEPTANCE_READ_ID/_SECRET and, optionally,
                      IMSG_ACCEPTANCE_SEND_ID/_SECRET)
  --local             acceptance: also check the origin and /healthz on this Mac
  --refusal-test      acceptance: send to a non-allowlisted number and expect a refusal

Docs: https://github.com/project-nomos/imsg-mcp
`;

interface Args {
  command: string;
  config?: string;
  to?: string;
  send: boolean;
  wait: boolean;
  timeout?: number;
  force: boolean;
  launchd: boolean;
  publicUrl?: string;
  agentUrl?: string;
  local: boolean;
  refusalTest: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "serve",
    send: true,
    wait: true,
    force: false,
    launchd: false,
    local: false,
    refusalTest: false,
  };
  let commandSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === "--config" || a === "-c") args.config = value();
    else if (a.startsWith("--config=")) args.config = a.slice(9);
    else if (a === "--to") args.to = value();
    else if (a === "--no-send") args.send = false;
    else if (a === "--no-wait") args.wait = false;
    else if (a === "--timeout") args.timeout = Number(value());
    else if (a === "--force") args.force = true;
    else if (a === "--launchd") args.launchd = true;
    else if (a === "--public-url") args.publicUrl = value();
    else if (a === "--agent-url") args.agentUrl = value();
    else if (a === "--local") args.local = true;
    else if (a === "--refusal-test") args.refusalTest = true;
    else if (a === "-h" || a === "--help") args.command = "help";
    else if (a === "-v" || a === "--version") args.command = "version";
    else if (!a.startsWith("-") && !commandSet) {
      args.command = a;
      commandSet = true;
    } else usage(`unknown argument: ${a}`);
  }
  if (args.timeout !== undefined && (!Number.isFinite(args.timeout) || args.timeout <= 0)) {
    usage("--timeout must be a positive number of seconds");
  }
  return args;
}

function usage(message: string): never {
  process.stderr.write(`imsg-mcp: ${message}\n\n${HELP}`);
  process.exit(EX_USAGE);
}

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function loadConfigOrExit(path: string): ConfigStore {
  try {
    return ConfigStore.load(path);
  } catch (err) {
    process.stderr.write(`imsg-mcp: ${(err as Error).message}\n`);
    process.exit(EX_CONFIG);
  }
}

function setupLogging(paths: Paths, config: ConfigStore, stderr: "warn" | "error") {
  const cfg = config.current;
  const { logger, file } = createLogger({
    dir: paths.logDir,
    retentionDays: cfg.logging.server_retention_days,
    level: cfg.logging.level,
    stderr,
  });
  const audit = new FileAuditLog(paths.logDir, cfg.logging.audit_retention_days);
  const warning = configPermissionWarning(config.path);
  if (warning) logger.warn(warning);
  for (const w of configWarnings(cfg)) logger.warn(w);
  return { logger, file, audit };
}

/** SIGHUP reloads the config; a bad file keeps the old one. */
function handleReload(config: ConfigStore, logger: Logger, extra?: () => void): void {
  process.on("SIGHUP", () => {
    const res = config.reload();
    if (!res.ok) {
      logger.error("config reload failed; keeping the previous config", { error: res.error });
      return;
    }
    const cfg = config.current;
    logger.setLevel(cfg.logging.level);
    extra?.();
    logger.info("config reloaded", {
      send_enabled: cfg.send.enabled,
      allowlist_size: cfg.send.allowlist.size,
      read_scope: cfg.read.scope.mode === "all" ? "all" : cfg.read.scope.size,
      restart_required_for: res.restartRequired,
    });
    for (const w of configWarnings(cfg)) logger.warn(w);
  });
}

async function serve(args: Args, paths: Paths): Promise<void> {
  const configPath = args.config ?? paths.configFile;
  const config = loadConfigOrExit(configPath);
  const remote = remoteModeProblems(config.current);
  if (remote.length) {
    process.stderr.write(
      `imsg-mcp: the HTTP server needs Cloudflare Access settings in ${configPath}:\n  - ${remote.join("\n  - ")}\n` +
        `(For a local client without Cloudflare, use "imsg-mcp stdio".)\n`,
    );
    process.exit(EX_CONFIG);
  }
  const { logger, file, audit } = setupLogging(paths, config, "warn");

  let app: App;
  try {
    app = await App.create({
      config,
      logger,
      audit,
      stateDbPath: stateDbPath(paths),
      mode: "http",
    });
  } catch (err) {
    logger.error("startup failed", { error: err as Error });
    process.stderr.write(`imsg-mcp: ${(err as Error).message}\n`);
    process.exit(err instanceof StartupError ? EX_UNAVAILABLE : 1);
  }
  app.start();
  const monitor = new HealthMonitor(app);
  monitor.start();

  const cfg = config.current;
  const mcp = startMcpHttpServer(app, cfg.server.listen.host, cfg.server.listen.port);
  const health = startHealthServer(
    monitor,
    cfg.server.health_listen.host,
    cfg.server.health_listen.port,
  );
  logger.info("imsg-mcp listening", {
    version: VERSION,
    mcp: mcp.url,
    health: health.url,
    send_enabled: cfg.send.enabled,
    pid: process.pid,
  });
  process.stderr.write(`imsg-mcp ${VERSION} listening on ${mcp.url} (health: ${health.url})\n`);

  handleReload(config, logger, () => {
    audit.setRetentionDays(config.current.logging.audit_retention_days);
    file?.setRetentionDays(config.current.logging.server_retention_days);
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    monitor.stop();
    await Promise.allSettled([mcp.stop(), health.stop()]);
    await app.stop();
    audit.close();
    file?.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function stdio(args: Args, paths: Paths): Promise<void> {
  const config = loadConfigOrExit(args.config ?? paths.configFile);
  // stdout carries MCP; logs go to the file and serious ones to stderr.
  const { logger, file, audit } = setupLogging(paths, config, "error");
  let app: App;
  try {
    app = await App.create({
      config,
      logger,
      audit,
      stateDbPath: stateDbPath(paths),
      mode: "stdio",
    });
  } catch (err) {
    process.stderr.write(`imsg-mcp: ${(err as Error).message}\n`);
    process.exit(err instanceof StartupError ? EX_UNAVAILABLE : 1);
  }
  app.start();
  const monitor = new HealthMonitor(app);
  monitor.start({ heartbeat: false });
  const session = await serveStdio(app);
  handleReload(config, logger);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    monitor.stop();
    await session.close().catch(() => undefined);
    await app.stop();
    audit.close();
    file?.close();
    process.exit(0);
  };
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

async function checkConfig(args: Args, paths: Paths): Promise<void> {
  const configPath = args.config ?? paths.configFile;
  const config = loadConfigOrExit(configPath);
  const cfg = config.current;
  let ok = true;
  print(`Config: ${configPath}`);
  print(`  MCP endpoint      http://${cfg.server.listen.host}:${cfg.server.listen.port}/mcp`);
  print(
    `  Health endpoint   http://${cfg.server.health_listen.host}:${cfg.server.health_listen.port}/healthz`,
  );
  print(`  Access team       ${cfg.access.team_domain ?? "(not set)"}`);
  print(`  Access AUD tags   ${cfg.access.aud.length}`);
  print(`  People            ${cfg.access.people.join(", ") || "(none)"}`);
  const tokens = Object.entries(cfg.access.service_tokens);
  print(
    `  Service tokens    ${tokens.length ? tokens.map(([id, role]) => `${id} (${role})`).join(", ") : "(none)"}`,
  );
  print(
    `  Sending           ${cfg.send.enabled ? "ON" : "off"}; allowlist ${cfg.send.allowlist.size}; max ${cfg.send.max_chars} chars; ${formatRate(cfg.send.rate)}`,
  );
  print(
    `  Read scope        ${cfg.read.scope.mode === "all" ? "all chats" : `${cfg.read.scope.size} entries`}`,
  );
  print(`  Heartbeat         ${cfg.heartbeat.url ? "configured" : "(not set)"}`);

  const problems = remoteModeProblems(cfg);
  for (const p of problems) print(`  ! HTTP mode: ${p}`);
  const warning = configPermissionWarning(configPath);
  if (warning) print(`  ! ${warning}`);
  for (const w of configWarnings(cfg)) print(`  ! ${w}`);

  const imsgPath = resolveImsgPath(cfg.imsg.path);
  try {
    const status = await readImsgStatus([imsgPath]);
    const missing = missingRequiredMethods(status);
    print(`imsg: ${imsgPath} (version ${status.version})`);
    if (missing.length) {
      ok = false;
      print(`  ! missing required RPC methods: ${missing.join(", ")}`);
    } else {
      print(`  RPC methods OK (${status.rpcMethods.size} available)`);
    }
  } catch (err) {
    ok = false;
    print(`imsg: ${(err as Error).message}`);
  }
  process.exit(ok ? 0 : 1);
}

function init(args: Args, paths: Paths): void {
  const target = args.config ?? paths.configFile;
  if (existsSync(target) && !args.force) {
    process.stderr.write(`imsg-mcp: ${target} already exists (use --force to overwrite)\n`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, EXAMPLE_CONFIG, { mode: 0o600 });
  chmodSync(target, 0o600);
  print(`Wrote ${target} (mode 0600).`);
  print(
    "Next: set access.team_domain, access.aud and access.people, then run: imsg-mcp check-config",
  );
}

async function selftest(args: Args, paths: Paths): Promise<void> {
  const configPath = resolvePath(args.config ?? paths.configFile);
  const config = loadConfigOrExit(configPath);
  if (args.launchd) {
    const forward = ["--config", configPath];
    if (args.to) forward.push("--to", args.to);
    if (!args.send) forward.push("--no-send");
    if (!args.wait) forward.push("--no-wait");
    if (args.timeout) forward.push("--timeout", String(args.timeout));
    const waitS = (args.timeout ?? config.current.selftest.reply_timeout_seconds) + 90;
    try {
      const ok = await runSelftestViaLaunchd(forward, print, waitS * 1000);
      process.exit(ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(`imsg-mcp: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }
  if (!process.env.XPC_SERVICE_NAME?.includes(".selftest.")) {
    print(
      "Note: started from a terminal, macOS checks the terminal's permissions, not imsg-mcp's.",
    );
    print("      Use --launchd to test the grants the service itself runs with.");
  }
  const { logger, file, audit } = setupLogging(paths, config, "error");
  const ok = await runSelftest({
    config,
    logger,
    audit,
    stateDbPath: stateDbPath(paths),
    to: args.to,
    send: args.send,
    waitForReply: args.wait,
    replyTimeoutSeconds: args.timeout,
    out: print,
  });
  audit.close();
  file?.close();
  process.exit(ok ? 0 : 1);
}

function envToken(prefix: string): { id: string; secret: string } | undefined {
  const id = process.env[`${prefix}_ID`];
  const secret = process.env[`${prefix}_SECRET`];
  return id && secret ? { id, secret } : undefined;
}

async function acceptance(args: Args, paths: Paths): Promise<void> {
  let localMcpUrl: string | undefined;
  let healthUrl: string | undefined;
  if (args.local) {
    const cfg = loadConfigOrExit(args.config ?? paths.configFile).current;
    localMcpUrl = `http://${cfg.server.listen.host}:${cfg.server.listen.port}/mcp`;
    healthUrl = `http://${cfg.server.health_listen.host}:${cfg.server.health_listen.port}/healthz`;
  }
  const ok = await runAcceptance(
    {
      publicUrl: args.publicUrl,
      agentUrl: args.agentUrl,
      readToken: envToken("IMSG_ACCEPTANCE_READ"),
      sendToken: envToken("IMSG_ACCEPTANCE_SEND"),
      localMcpUrl,
      healthUrl,
      refusalTest: args.refusalTest,
    },
    print,
  );
  process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
  // Everything this process creates (state.db, logs, config) is private to its user.
  process.umask(0o077);
  const args = parseArgs(process.argv.slice(2));
  const paths = defaultPaths();
  switch (args.command) {
    case "serve":
      return serve(args, paths);
    case "stdio":
      return stdio(args, paths);
    case "selftest":
      return selftest(args, paths);
    case "check-config":
      return checkConfig(args, paths);
    case "acceptance":
      return acceptance(args, paths);
    case "init":
      return init(args, paths);
    case "version":
      print(VERSION);
      return;
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      usage(`unknown command: ${args.command}`);
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`imsg-mcp: ${err.message}\n`);
    process.exit(EX_CONFIG);
  }
  process.stderr.write(`imsg-mcp: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
