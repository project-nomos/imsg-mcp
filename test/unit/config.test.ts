import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { EXAMPLE_CONFIG } from "../../src/config/example";
import { parseRate } from "../../src/config/rate";
import {
  buildConfig,
  ConfigError,
  configWarnings,
  remoteModeProblems,
} from "../../src/config/schema";
import { ConfigStore, configPermissionWarning, loadConfigFile } from "../../src/config/store";
import { tempDir } from "../helpers/harness";

function problems(data: unknown): string[] {
  try {
    buildConfig(data);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
}

describe("defaults", () => {
  test("match the spec", () => {
    const cfg = buildConfig({});
    expect(cfg.send.enabled).toBe(false);
    expect(cfg.send.allowlist.size).toBe(0);
    expect(cfg.send.max_chars).toBe(1000);
    expect(cfg.send.rate_spec).toBe("10/hour, 40/day");
    expect(cfg.send.rate).toEqual([
      { limit: 10, windowMs: 3_600_000, unit: "hour" },
      { limit: 40, windowMs: 86_400_000, unit: "day" },
    ]);
    expect(cfg.read.scope).toEqual({ mode: "all" });
    expect(cfg.read.max_text_chars).toBe(4000);
    expect(cfg.server.listen).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(cfg.server.health_listen).toEqual({ host: "127.0.0.1", port: 8788 });
    expect(cfg.imsg.call_timeout_ms).toBe(10_000);
    expect(cfg.imsg.restart_initial_ms).toBe(1_000);
    expect(cfg.imsg.restart_max_ms).toBe(30_000);
    expect(cfg.store.retention_days).toBe(14);
    expect(cfg.logging.audit_retention_days).toBe(90);
    expect(cfg.logging.server_retention_days).toBe(14);
    expect(cfg.heartbeat.interval_seconds).toBe(300);
    expect(cfg.health.sync_check_interval_seconds).toBe(600);
  });

  test("the example config parses and is the one shipped in deploy/", () => {
    const shipped = readFileSync(
      resolve(import.meta.dir, "../../deploy/config.example.toml"),
      "utf8",
    );
    expect(shipped).toBe(EXAMPLE_CONFIG);
    const cfg = buildConfig(parseToml(EXAMPLE_CONFIG));
    expect(cfg.send.enabled).toBe(false);
    expect(remoteModeProblems(cfg).length).toBe(3);
  });
});

describe("validation", () => {
  test("rejects unknown keys so typos cannot pass silently", () => {
    const p = problems({ send: { enable: true } });
    expect(p.join("\n")).toContain('unknown key(s) "enable"');
  });

  test("rejects a non-loopback listen address", () => {
    expect(problems({ server: { listen: "0.0.0.0:8787" } }).join()).toContain(
      "must bind to loopback",
    );
    expect(problems({ server: { listen: "[::1]:8787" } })).toEqual([]);
    expect(problems({ server: { listen: "localhost:9000" } })).toEqual([]);
  });

  test("rejects the same port for MCP and health", () => {
    expect(
      problems({ server: { listen: "127.0.0.1:9000", health_listen: "127.0.0.1:9000" } }).join(),
    ).toContain("different ports");
  });

  test("allowlist accepts E.164, email and chat ids, rejects the rest", () => {
    const cfg = buildConfig({
      send: { allowlist: ["+14155550123", "Friend@Example.com", 42, "7", "+44 20 7946 0958"] },
    });
    expect([...cfg.send.allowlist.handles].sort()).toEqual(
      ["+442079460958", "+14155550123", "friend@example.com"].sort(),
    );
    expect([...cfg.send.allowlist.chatIds].sort((a, b) => a - b)).toEqual([7, 42]);
    expect(cfg.send.allowlist.size).toBe(5);

    expect(problems({ send: { allowlist: ["(415) 555-0123"] } }).join()).toContain("not an E.164");
    expect(problems({ send: { allowlist: ["14155550123"] } }).join()).toContain("not an E.164");
    expect(problems({ send: { allowlist: [-3] } }).join()).toContain("not a valid chat id");
    // A phone number written as a bare TOML integer is not mistaken for a chat id.
    expect(problems({ send: { allowlist: [14155550123] } }).join()).toContain("quoted E.164");
    expect(problems({ read: { scope: [14155550123] } }).join()).toContain("quoted E.164");
  });

  test("read.scope parses chat ids, handles and chat identifiers", () => {
    const cfg = buildConfig({
      read: { scope: [42, "+14155550123", "iMessage;+;chat99", "jane@example.com"] },
    });
    const scope = cfg.read.scope;
    if (scope.mode !== "list") throw new Error("expected list");
    expect([...scope.chatIds]).toEqual([42]);
    expect([...scope.handles].sort()).toEqual(["+14155550123", "jane@example.com"]);
    expect([...scope.chatKeys]).toEqual(["iMessage;+;chat99"]);
    expect(problems({ read: { scope: ["415-555-0123"] } }).join()).toContain(
      "looks like a phone number",
    );
  });

  test("access settings are normalized", () => {
    const cfg = buildConfig({
      access: {
        team_domain: "https://MyTeam.cloudflareaccess.com/",
        aud: "single-aud",
        people: ["Me@Example.com"],
        service_tokens: { "abc.access": "read" },
      },
    });
    expect(cfg.access.team_domain).toBe("myteam.cloudflareaccess.com");
    expect(cfg.access.aud).toEqual(["single-aud"]);
    expect(cfg.access.people).toEqual(["me@example.com"]);
    expect(remoteModeProblems(cfg)).toEqual([]);
    expect(
      problems({ access: { service_tokens: { "abc.access": "admin" } } }).length,
    ).toBeGreaterThan(0);
  });

  test("heartbeat URL and selftest recipient are checked", () => {
    expect(problems({ heartbeat: { url: "not a url" } }).join()).toContain("heartbeat.url");
    expect(problems({ selftest: { to: "12345" } }).join()).toContain("selftest.to");
    expect(buildConfig({ selftest: { to: "+1 415 555 0123" } }).selftest.to).toBe("+14155550123");
  });

  test("warnings call out risky but valid settings", () => {
    const cfg = buildConfig({ send: { enabled: true }, read: { scope: [] } });
    const w = configWarnings(cfg).join("\n");
    expect(w).toContain("allowlist is empty");
    expect(w).toContain("empty list");
    expect(w).toContain("heartbeat.url is not set");
  });
});

describe("rate parsing", () => {
  test("parses windows", () => {
    expect(parseRate("10/hour, 40/day")).toEqual([
      { limit: 10, windowMs: 3_600_000, unit: "hour" },
      { limit: 40, windowMs: 86_400_000, unit: "day" },
    ]);
    expect(parseRate("5/2h")).toEqual([{ limit: 5, windowMs: 7_200_000, unit: "2 hours" }]);
    expect(parseRate("3 / minutes")).toEqual([{ limit: 3, windowMs: 60_000, unit: "minute" }]);
  });

  test("rejects nonsense", () => {
    expect(() => parseRate("")).toThrow();
    expect(() => parseRate("10 per hour")).toThrow();
    expect(() => parseRate("0/hour")).toThrow();
    expect(() => parseRate("10/ms")).toThrow();
    expect(() => parseRate("10/fortnight")).toThrow();
  });
});

describe("ConfigStore", () => {
  test("loads, reloads, and keeps the old config when the file is broken", () => {
    const dir = tempDir();
    const path = join(dir, "config.toml");
    writeFileSync(path, `[send]\nenabled = false\n`, { mode: 0o600 });
    const store = ConfigStore.load(path);
    expect(store.current.send.enabled).toBe(false);

    const seen: boolean[] = [];
    store.onChange((next) => seen.push(next.send.enabled));

    writeFileSync(path, `[send]\nenabled = true\nallowlist = ["+14155550123"]\n`);
    const ok = store.reload();
    expect(ok).toEqual({ ok: true, restartRequired: [] });
    expect(store.current.send.enabled).toBe(true);
    expect(seen).toEqual([true]);

    writeFileSync(path, `[send]\nenabled = "yes please"\n`);
    const bad = store.reload();
    expect(bad.ok).toBe(false);
    expect(store.current.send.enabled).toBe(true);
    expect(seen).toEqual([true]);

    writeFileSync(path, `[server]\nlisten = "127.0.0.1:9999"\n`);
    const moved = store.reload();
    expect(moved).toEqual({ ok: true, restartRequired: ["server.listen"] });
  });

  test("reports invalid TOML and a missing file", () => {
    const dir = tempDir();
    const path = join(dir, "config.toml");
    expect(() => loadConfigFile(path)).toThrow(/not found/);
    writeFileSync(path, "[send\n");
    expect(() => loadConfigFile(path)).toThrow(/not valid TOML/);
  });

  test("warns when the config is readable by others", () => {
    const dir = tempDir();
    const path = join(dir, "config.toml");
    writeFileSync(path, "");
    chmodSync(path, 0o644);
    expect(configPermissionWarning(path)).toContain("chmod 600");
    chmodSync(path, 0o600);
    expect(configPermissionWarning(path)).toBeUndefined();
  });
});
