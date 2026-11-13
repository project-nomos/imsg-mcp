import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Methods the server cannot work without. `imsg-mcp` refuses to start if any is missing. */
export const REQUIRED_RPC_METHODS = [
  "chats.list",
  "messages.history",
  "watch.subscribe",
  "send",
] as const;

/** Optional methods used when present (imsg 0.14+ and 0.16+). */
export const OPTIONAL_RPC_METHODS = ["messages.search", "chats.get", "watch.unsubscribe"] as const;

export interface ImsgStatus {
  version: string;
  rpcMethods: Set<string>;
  /** Parsed `imsg status --json`, for `get_status`. Contains no message content. */
  raw: Record<string, unknown>;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(
  argv: string[],
  timeoutMs = 15_000,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const [program, ...args] = argv;
  if (!program) return Promise.reject(new Error("empty command"));
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env: env ?? process.env },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`${program} not found`));
          return;
        }
        if (err && err.killed) {
          reject(new Error(`${program} ${args.join(" ")} timed out after ${timeoutMs} ms`));
          return;
        }
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Resolves the `imsg` executable. launchd starts agents with a minimal PATH, so the
 * Homebrew locations are searched explicitly.
 */
export function resolveImsgPath(configured: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(configured) || configured.includes("/")) return configured;
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const candidate = join(dir, configured);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return configured;
}

/** Runs `imsg status --json` (and `imsg --version` when status has no version). */
export async function readImsgStatus(
  imsgCommand: string[],
  env?: NodeJS.ProcessEnv,
): Promise<ImsgStatus> {
  const res = await runCommand([...imsgCommand, "status", "--json"], 15_000, env);
  const line = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) {
    throw new Error(
      `"imsg status --json" printed no JSON (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`,
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`"imsg status --json" printed invalid JSON`);
  }
  const methods = Array.isArray(raw.rpc_methods)
    ? raw.rpc_methods.filter((m): m is string => typeof m === "string")
    : Array.isArray(raw.methods)
      ? raw.methods.filter((m): m is string => typeof m === "string")
      : [];

  let version = typeof raw.version === "string" ? raw.version : "";
  if (!version) {
    try {
      const v = await runCommand([...imsgCommand, "--version"], 5_000, env);
      version = v.stdout.trim().split("\n")[0]?.trim() ?? "";
    } catch {
      version = "";
    }
  }
  // Drop the long human-readable setup prose; keep the machine-readable fields.
  const { message: _message, ...compact } = raw;
  return { version: version || "unknown", rpcMethods: new Set(methods), raw: compact };
}

export function missingRequiredMethods(status: ImsgStatus): string[] {
  return REQUIRED_RPC_METHODS.filter((m) => !status.rpcMethods.has(m));
}
