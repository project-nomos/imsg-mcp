import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * The effective user's home from the user database. `sudo -u imsgbot` on macOS can keep
 * the caller's $HOME, which would point the server at the wrong config.
 */
function effectiveHome(env: NodeJS.ProcessEnv): string {
  try {
    const home = userInfo().homedir;
    if (home) return home;
  } catch {
    // fall through
  }
  return env.HOME || homedir();
}

/**
 * Filesystem locations. Every path can be overridden with an environment variable,
 * which is how the tests (and unusual installs) point the server somewhere else.
 */
export interface Paths {
  /** `config.toml` */
  configFile: string;
  /** Directory holding `state.db`. */
  stateDir: string;
  /** Directory holding `server.log` and `audit.jsonl`. */
  logDir: string;
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = effectiveHome(env);
  const appSupport = join(home, "Library", "Application Support", "imsg-mcp");
  return {
    configFile: env.IMSG_MCP_CONFIG || join(appSupport, "config.toml"),
    stateDir: env.IMSG_MCP_STATE_DIR || appSupport,
    logDir: env.IMSG_MCP_LOG_DIR || join(home, "Library", "Logs", "imsg-mcp"),
  };
}

export function stateDbPath(paths: Paths): string {
  return join(paths.stateDir, "state.db");
}

/** Where the install script puts the signed binary. Privacy grants are tied to it. */
export const INSTALLED_BINARY = "/usr/local/libexec/imsg-mcp/imsg-mcp";

/** Default launchd label for the LaunchAgent. */
export const DEFAULT_LAUNCHD_LABEL = "ai.mynomos.imsg-mcp";
