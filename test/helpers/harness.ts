import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT, type JWK } from "jose";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "../../src/app";
import { buildConfig } from "../../src/config/schema";
import { ConfigStore } from "../../src/config/store";
import { startMcpHttpServer, type RunningServer } from "../../src/http/mcp-http";
import { fakeMessagesApp } from "../../src/imsg/messages-app";
import { MemoryAuditLog } from "../../src/log/audit";
import { memoryLogger } from "../../src/log/logger";
import { fixtureDb, type FixtureDb } from "./fixtures";

export const STUB = resolve(import.meta.dir, "../fixtures/stub-imsg.ts");
export const TEAM = "test-team.cloudflareaccess.com";
export const AUD_PEOPLE = "aud-people-0001";
export const AUD_AGENT = "aud-agent-0002";
export const OWNER = "owner@example.com";

export function tempDir(prefix = "imsg-mcp-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function waitFor<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 5000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

/** RSA key pair standing in for Cloudflare Access's signing key. */
export async function accessKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
  const keySource = createLocalJWKSet({ keys: [jwk] });
  const sign = (
    claims: Record<string, unknown>,
    opts: { aud?: string | string[]; iss?: string; exp?: string | number } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(opts.iss ?? `https://${TEAM}`)
      .setAudience(opts.aud ?? AUD_PEOPLE)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(privateKey);
  return { keySource, sign, privateKey };
}

export function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, Record<string, unknown>> = {
    server: { listen: "127.0.0.1:0", health_listen: "127.0.0.1:0" },
    imsg: { call_timeout_ms: 3000, restart_initial_ms: 100, restart_max_ms: 400 },
    send: {
      enabled: true,
      allowlist: ["+14155550101", "carol@example.com"],
      confirm_timeout_ms: 1500,
    },
    access: {
      team_domain: TEAM,
      aud: [AUD_PEOPLE, AUD_AGENT],
      people: [OWNER],
      service_tokens: { "reader.access": "read", "sender.access": "read_send" },
    },
  };
  for (const [section, values] of Object.entries(overrides)) {
    base[section] = { ...(base[section] ?? {}), ...(values as Record<string, unknown>) };
  }
  return base;
}

type KeySource = Parameters<typeof App.create>[0]["keySource"];

export interface HarnessOptions {
  config?: Record<string, unknown>;
  /** JWKS for verifying test Access tokens (from accessKeys()). */
  keySource?: KeySource;
  db?: FixtureDb;
  version?: "0.8.2" | "0.21.0";
  messagesRunning?: boolean;
  start?: boolean;
}

/** A running App wired to the stub imsg, with a temp state dir. */
export class Harness {
  readonly dir: string;
  readonly dbPath: string;
  readonly statePath: string;
  readonly audit = new MemoryAuditLog();
  readonly log = memoryLogger();
  readonly messagesApp;
  config!: ConfigStore;
  app!: App;
  private http: RunningServer | undefined;
  private readonly version: string;

  constructor(private readonly opts: HarnessOptions = {}) {
    this.dir = tempDir();
    this.dbPath = join(this.dir, "chatdb.json");
    this.statePath = join(this.dir, "state.db");
    this.version = opts.version ?? "0.8.2";
    this.messagesApp = fakeMessagesApp(opts.messagesRunning ?? true);
    this.writeDb(opts.db ?? fixtureDb());
  }

  get env(): NodeJS.ProcessEnv {
    return { ...process.env, STUB_IMSG_DB: this.dbPath, STUB_IMSG_VERSION: this.version };
  }

  async start(): Promise<this> {
    this.config = new ConfigStore(
      join(this.dir, "config.toml"),
      buildConfig(baseConfig(this.opts.config)),
    );
    this.app = await this.createApp();
    if (this.opts.start !== false) {
      this.app.start();
      await waitFor(() => this.app.watcher.subscribed, 5000, "watch subscription");
    }
    return this;
  }

  async createApp(keySource: KeySource = this.opts.keySource): Promise<App> {
    return App.create({
      config: this.config,
      logger: this.log.logger,
      audit: this.audit,
      stateDbPath: this.statePath,
      imsgCommand: [process.execPath, STUB],
      imsgEnv: this.env,
      messagesApp: this.messagesApp,
      keySource,
      mode: "http",
      sleep: (ms) => Bun.sleep(Math.min(ms, 50)),
    });
  }

  /** Restarts the App (new process state, same state.db), like a server restart. */
  async restart(): Promise<void> {
    await this.stopHttp();
    await this.app.stop();
    this.app = await this.createApp();
    this.app.start();
    await waitFor(() => this.app.watcher.subscribed, 5000, "watch subscription after restart");
  }

  readDb(): FixtureDb {
    return JSON.parse(readFileSync(this.dbPath, "utf8")) as FixtureDb;
  }

  writeDb(db: FixtureDb): void {
    const tmp = `${this.dbPath}.test.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, this.dbPath);
  }

  /** Appends a message to the fake chat.db, as if it had just arrived. Returns its rowid. */
  inject(message: {
    chat_id: number;
    text: string;
    sender?: string;
    is_from_me?: boolean;
    sender_name?: string;
  }): number {
    const db = this.readDb();
    const id = db.messages.reduce((acc, m) => Math.max(acc, Number(m.id)), 0) + 1;
    db.messages.push({
      id,
      chat_id: message.chat_id,
      guid: `INJ-${id}`,
      sender: message.sender ?? "",
      sender_name: message.sender_name,
      is_from_me: message.is_from_me ?? false,
      text: message.text,
      created_at: new Date().toISOString(),
    });
    this.writeDb(db);
    return id;
  }

  setBehavior(behavior: Record<string, unknown>): void {
    const db = this.readDb();
    db.behavior = { ...(db.behavior ?? {}), ...behavior };
    this.writeDb(db);
  }

  async startHttp(): Promise<string> {
    this.http = startMcpHttpServer(this.app, "127.0.0.1", 0);
    return this.http.url;
  }

  async stopHttp(): Promise<void> {
    await this.http?.stop();
    this.http = undefined;
  }

  async stop(): Promise<void> {
    await this.stopHttp();
    await this.app?.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export async function connectClient(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "imsg-mcp-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : undefined,
  });
  await client.connect(transport);
  return client;
}

export function parseToolText(result: unknown): Record<string, unknown> {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { _text: text, _isError: r.isError };
  }
}

export function toolText(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}
