import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers/harness";

// The release pipeline: the Release workflow asks scripts/next-version.sh for the version,
// runs scripts/bump-version.sh, then scripts/release-notes.sh, scripts/build-mcpb.sh (with
// deploy/mcpb/manifest.json) and scripts/server-json.sh. These tests keep the pieces in
// step with each other.

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

/** A changelog with notes waiting under Unreleased, in the repo's format. */
function changelog(unreleased: string, current: string): string {
  return [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    unreleased,
    "",
    `## [${current}] - 2026-11-13`,
    "",
    "First release.",
    "",
    `[Unreleased]: https://github.com/project-nomos/imsg-mcp/compare/v${current}...HEAD`,
    `[${current}]: https://github.com/project-nomos/imsg-mcp/releases/tag/v${current}`,
    "",
  ].join("\n");
}

/**
 * A copy of the files the release scripts read and edit, so the tests never touch the
 * repo. The changelog is written fresh: after a release the repo's Unreleased is empty.
 */
function copy(unreleased = "### Added\n\n- Something new."): string {
  const dir = tempDir("imsg-mcp-release-");
  for (const f of [...VERSIONED, "scripts/bump-version.sh", "scripts/next-version.sh"]) {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  writeFileSync(join(dir, "CHANGELOG.md"), changelog(unreleased, current));
  return dir;
}

const current = readJson<{ version: string }>(join(ROOT, "package.json")).version;
const [major, minor, patch] = current.split(".").map(Number) as [number, number, number];
const nextMinor = `${major}.${minor + 1}.0`;
const nextPatch = `${major}.${minor}.${patch + 1}`;

describe("next-version.sh", () => {
  const next = (unreleased: string) => sh("next-version.sh", [], copy(unreleased));

  test("Added, Changed, Deprecated or Removed entries make a minor release", () => {
    for (const section of ["Added", "Changed", "Deprecated", "Removed"]) {
      expect(next(`### ${section}\n\n- An entry.`).stdout.trim()).toBe(nextMinor);
    }
    expect(next("### Fixed\n\n- A fix.\n\n### Added\n\n- A feature.").stdout.trim()).toBe(
      nextMinor,
    );
  });

  test("only Fixed or Security entries make a patch release", () => {
    expect(next("### Fixed\n\n- A fix.").stdout.trim()).toBe(nextPatch);
    expect(next("### Security\n\n- An update.\n  More about it.").stdout.trim()).toBe(nextPatch);
  });

  test("no entries, or headings without entries, release nothing", () => {
    for (const unreleased of ["", "### Added", "### Added\n\nSome prose, not an entry."]) {
      const r = next(unreleased);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
  });
});

describe("bump-version.sh", () => {
  test("changes only the version lines and opens a changelog section for the release", () => {
    const dir = copy();
    const r = sh("bump-version.sh", [nextMinor], dir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    for (const f of VERSIONED) {
      const before = readFileSync(join(ROOT, f), "utf8").split("\n");
      const after = readFileSync(join(dir, f), "utf8").split("\n");
      expect(readJson<{ version: string }>(join(dir, f)).version).toBe(nextMinor);
      const changed = after.filter((line, i) => line !== before[i]);
      expect(changed).toEqual([expect.stringContaining(`"version": "${nextMinor}"`)]);
    }
    const log = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(log).toMatch(
      new RegExp(`## \\[Unreleased\\]\\n\\n## \\[${nextMinor}\\] - \\d{4}-\\d{2}-\\d{2}\\n`),
    );
    expect(log).toContain(
      `[Unreleased]: https://github.com/project-nomos/imsg-mcp/compare/v${nextMinor}...HEAD\n` +
        `[${nextMinor}]: https://github.com/project-nomos/imsg-mcp/releases/tag/v${nextMinor}\n`,
    );
    // The notes moved, so the next version has nothing to release yet.
    expect(sh("next-version.sh", [], dir).stdout).toBe("");
  });

  test("refuses the current version, an older one, and an empty Unreleased section", () => {
    expect(sh("bump-version.sh", [current], copy()).code).toBe(64);
    expect(sh("bump-version.sh", ["0.0.1"], copy()).code).toBe(64);
    const dir = copy();
    expect(sh("bump-version.sh", [nextMinor], dir).code).toBe(0);
    expect(sh("bump-version.sh", [`${major}.${minor + 2}.0`], dir).code).toBe(65);
  });
});
