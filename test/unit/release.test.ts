import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers/harness";

// The release pipeline: scripts/bump-version.sh starts it, the Release workflow runs
// scripts/release-notes.sh, scripts/build-mcpb.sh (with deploy/mcpb/manifest.json) and
// scripts/server-json.sh. These tests keep the pieces in step with each other.

const ROOT = join(import.meta.dir, "..", "..");
const VERSIONED = [
  "package.json",
  "plugins/imsg-mcp/plugin.json",
  "plugins/imsg-mcp/.claude-plugin/plugin.json",
  "deploy/mcpb/manifest.json",
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sh(script: string, args: string[], cwd = ROOT) {
  const r = Bun.spawnSync(["bash", join(cwd, "scripts", script), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function registeredTools(): string[] {
  const dir = join(ROOT, "src", "tools");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) =>
      [...readFileSync(join(dir, f), "utf8").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map(
        (m) => m[1]!,
      ),
    );
}

interface BundleManifest {
  name: string;
  version: string;
  server: {
    type: string;
    mcp_config: { command: string; args: string[]; env: Record<string, string> };
  };
  user_config: Record<string, unknown>;
  tools: { name: string }[];
  compatibility: { platforms: string[] };
}

describe("MCP Bundle manifest", () => {
  const manifest = readJson<BundleManifest>(join(ROOT, "deploy/mcpb/manifest.json"));

  test("has the package version and starts the bundled binary in stdio mode", () => {
    expect(manifest.version).toBe(
      readJson<{ version: string }>(join(ROOT, "package.json")).version,
    );
    expect(manifest.server.type).toBe("binary");
    expect(manifest.server.mcp_config.command).toBe("${__dirname}/server/imsg-mcp");
    expect(manifest.server.mcp_config.args).toEqual(["stdio"]);
    expect(manifest.compatibility.platforms).toEqual(["darwin"]);
  });

  test("passes only declared settings to the server", () => {
    for (const value of Object.values(manifest.server.mcp_config.env)) {
      for (const [, key] of value.matchAll(/\$\{user_config\.([a-z_]+)\}/g)) {
        expect(Object.keys(manifest.user_config)).toContain(key!);
      }
    }
  });

  test("lists exactly the tools the server registers", () => {
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(registeredTools().sort());
  });
});

describe("release scripts", () => {
  test("release-notes.sh prints one version's notes without its heading", () => {
    const r = sh("release-notes.sh", ["0.1.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("First release.")).toBe(true);
    expect(r.stdout).not.toContain("## [");
    expect(r.stdout).not.toMatch(/^\[[^\]]+\]: /m);
  });

  test("release-notes.sh fails for a version the changelog does not have", () => {
    expect(sh("release-notes.sh", ["9.9.9"]).code).not.toBe(0);
  });

  test("server-json.sh writes a registry entry for the release's bundle", () => {
    const sha = "a".repeat(64);
    const r = sh("server-json.sh", ["1.2.3", sha]);
    expect(r.code).toBe(0);
    const entry = JSON.parse(r.stdout) as {
      name: string;
      version: string;
      description: string;
      packages: { registryType: string; identifier: string; fileSha256: string }[];
    };
    expect(entry.name).toBe("io.github.project-nomos/imsg-mcp");
    expect(entry.version).toBe("1.2.3");
    expect(entry.description.length).toBeLessThanOrEqual(100);
    expect(entry.packages).toEqual([
      expect.objectContaining({
        registryType: "mcpb",
        identifier:
          "https://github.com/project-nomos/imsg-mcp/releases/download/v1.2.3/imsg-mcp-1.2.3-darwin-arm64.mcpb",
        fileSha256: sha,
      }),
    ]);
    expect(sh("server-json.sh", ["1.2.3", "not-a-hash"]).code).not.toBe(0);
  });
});

describe("bump-version.sh", () => {
  /** A copy of the files the script edits, so the test never touches the repo. */
  function copy(): string {
    const dir = tempDir("imsg-mcp-bump-");
    for (const f of [...VERSIONED, "CHANGELOG.md", "scripts/bump-version.sh"]) {
      mkdirSync(join(dir, dirname(f)), { recursive: true });
      cpSync(join(ROOT, f), join(dir, f));
    }
    return dir;
  }
  const current = readJson<{ version: string }>(join(ROOT, "package.json")).version;
  const [major, minor] = current.split(".").map(Number);
  const next = `${major}.${minor! + 1}.0`;

  test("changes only the version lines and opens a changelog section for the release", () => {
    const dir = copy();
    const r = sh("bump-version.sh", [next], dir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    for (const f of VERSIONED) {
      const before = readFileSync(join(ROOT, f), "utf8").split("\n");
      const after = readFileSync(join(dir, f), "utf8").split("\n");
      expect(readJson<{ version: string }>(join(dir, f)).version).toBe(next);
      const changed = after.filter((line, i) => line !== before[i]);
      expect(changed).toEqual([expect.stringContaining(`"version": "${next}"`)]);
    }
    const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(
      new RegExp(`## \\[Unreleased\\]\\n\\n## \\[${next}\\] - \\d{4}-\\d{2}-\\d{2}\\n`),
    );
    expect(changelog).toContain(
      `[Unreleased]: https://github.com/project-nomos/imsg-mcp/compare/v${next}...HEAD\n` +
        `[${next}]: https://github.com/project-nomos/imsg-mcp/releases/tag/v${next}\n`,
    );
  });

  test("refuses the current version, an older one, and an empty Unreleased section", () => {
    expect(sh("bump-version.sh", [current], copy()).code).toBe(64);
    expect(sh("bump-version.sh", ["0.0.1"], copy()).code).toBe(64);
    const dir = copy();
    expect(sh("bump-version.sh", [next], dir).code).toBe(0);
    expect(sh("bump-version.sh", [`${major}.${minor! + 2}.0`], dir).code).toBe(65);
  });
});
