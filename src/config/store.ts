import { existsSync, readFileSync, statSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { buildConfig, ConfigError, type Config } from "./schema";

export type ConfigListener = (next: Config, prev: Config) => void;

/** Reads and validates a config file. Throws ConfigError with every problem found. */
export function loadConfigFile(path: string): Config {
  if (!existsSync(path)) {
    throw new ConfigError([`config file not found at ${path}; run "imsg-mcp init" to create one`]);
  }
  let data: unknown;
  try {
    data = parseToml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError([`${path} is not valid TOML: ${(err as Error).message}`]);
  }
  return buildConfig(data);
}

/** Returns a warning when the config file is readable by other users. */
export function configPermissionWarning(path: string): string | undefined {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      return `${path} has mode ${mode.toString(8).padStart(4, "0")}; run "chmod 600" so only its owner can read it`;
    }
  } catch {
    // Missing file is reported elsewhere.
  }
  return undefined;
}

/**
 * Holds the live config. `reload()` re-reads the file (on SIGHUP); an invalid file
 * leaves the previous config in place, so a typo cannot open anything up.
 */
export class ConfigStore {
  private cfg: Config;
  private readonly listeners = new Set<ConfigListener>();

  constructor(
    readonly path: string,
    initial: Config,
  ) {
    this.cfg = initial;
  }

  static load(path: string): ConfigStore {
    return new ConfigStore(path, loadConfigFile(path));
  }

  get current(): Config {
    return this.cfg;
  }

  onChange(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Replaces the config in memory and notifies listeners. Used by reload and tests. */
  set(next: Config): void {
    const prev = this.cfg;
    this.cfg = next;
    for (const listener of this.listeners) listener(next, prev);
  }

  reload(): { ok: true; restartRequired: string[] } | { ok: false; error: string } {
    let next: Config;
    try {
      next = loadConfigFile(this.path);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const prev = this.cfg;
    const restartRequired: string[] = [];
    if (
      next.server.listen.host !== prev.server.listen.host ||
      next.server.listen.port !== prev.server.listen.port
    ) {
      restartRequired.push("server.listen");
    }
    if (
      next.server.health_listen.host !== prev.server.health_listen.host ||
      next.server.health_listen.port !== prev.server.health_listen.port
    ) {
      restartRequired.push("server.health_listen");
    }
    if (next.imsg.path !== prev.imsg.path || next.imsg.db !== prev.imsg.db) {
      restartRequired.push("imsg.path/imsg.db");
    }
    this.set(next);
    return { ok: true, restartRequired };
  }
}
