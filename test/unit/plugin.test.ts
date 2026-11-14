import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";

// The agent plugin in plugins/imsg-mcp carries two formats side by side: the portable
// Agent Plugins 1.0.0 package (plugin.json, skills/, and an mcp.example.json template)
// and Claude Code's own files (.claude-plugin/plugin.json, .mcp.json). These tests keep
// both valid and in step.

const ROOT = join(import.meta.dir, "..", "..");
const PLUGIN = join(ROOT, "plugins", "imsg-mcp");
const SCHEMAS = join(ROOT, "test", "fixtures", "agent-plugins", "1.0.0");

interface Manifest {
  $schema: string;
  name: string;
  version?: string;
  description?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  keywords?: string[];
}
interface McpConfig {
  $schema?: string;
  mcpServers: Record<string, { type: string; url?: string }>;
}

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(...parts), "utf8")) as T;
}

function schemaErrors(schema: "plugin" | "mcp", data: unknown): string {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(readJson(SCHEMAS, `${schema}.schema.json`));
  return validate(data) ? "" : JSON.stringify(validate.errors);
}

/** Tool names the server registers, read from the tool sources. */
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

const manifest = readJson<Manifest>(PLUGIN, "plugin.json");

describe("Agent Plugins package", () => {
  test("plugin.json matches the Agent Plugins 1.0.0 manifest schema", () => {
    expect(schemaErrors("plugin", manifest)).toBe("");
  });

  test("mcp.example.json matches the schema, targets the same version and uses HTTPS", () => {
    const mcp = readJson<McpConfig>(PLUGIN, "mcp.example.json");
    expect(schemaErrors("mcp", mcp)).toBe("");
    expect(mcp.$schema?.replace("/mcp.schema.json", "/plugin.schema.json")).toBe(manifest.$schema);
    const servers = Object.values(mcp.mcpServers);
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) expect(new URL(server.url ?? "").protocol).toBe("https:");
  });

  test("the published package carries no live mcp.json", () => {
    // Every user's server has its own address, and the portable format cannot ask for it,
    // so a shipped mcp.json would point every installation at the example host.
    expect(existsSync(join(PLUGIN, "mcp.json"))).toBe(false);
  });

  test("version and license follow package.json", () => {
    const pkg = readJson<{ version: string; license: string }>(ROOT, "package.json");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
  });

  test("every skill follows the Agent Skills rules and names only real tools", () => {
    const skillsDir = join(PLUGIN, "skills");
    const skills = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
    expect(skills.length).toBeGreaterThan(0);
    const tools = registeredTools();
    expect(tools).toContain("send_message");
    for (const name of skills) {
      const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(frontmatter).not.toBeNull();
      const fm = Bun.YAML.parse(frontmatter![1]!) as Record<string, unknown>;
      expect(fm.name).toBe(name);
      expect(name).toMatch(/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
      expect(typeof fm.description).toBe("string");
      expect((fm.description as string).length).toBeGreaterThan(0);
      expect((fm.description as string).length).toBeLessThanOrEqual(1024);
      if (fm.compatibility !== undefined) {
        expect(String(fm.compatibility).length).toBeLessThanOrEqual(500);
      }
      // Every `snake_case` identifier the skill presents as a tool must be a real tool.
      const named = [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!);
      const toolLike = named.filter((n) => /^(list|get|check|search|send)_/.test(n));
      expect(toolLike.length).toBeGreaterThan(0);
      for (const tool of toolLike) expect(tools).toContain(tool);
    }
  });
});

describe("Claude Code adapter", () => {
  const claude = readJson<Manifest & { userConfig?: Record<string, { required?: boolean }> }>(
    PLUGIN,
    ".claude-plugin",
    "plugin.json",
  );

  test("agrees with the portable manifest", () => {
    for (const key of [
      "name",
      "version",
      "description",
      "license",
      "homepage",
      "repository",
      "keywords",
    ] as const) {
      expect(claude[key]).toEqual(manifest[key]);
    }
  });

  test("asks for the server URL and uses it for the MCP server", () => {
    expect(claude.userConfig?.server_url?.required).toBe(true);
    const mcp = readJson<McpConfig>(PLUGIN, ".mcp.json");
    expect(mcp.mcpServers).toEqual({
      imessage: { type: "http", url: "${user_config.server_url}" },
    });
  });

  test("the marketplace lists the plugin from its folder", () => {
    const market = readJson<{ plugins: { name: string; source: string; description?: string }[] }>(
      ROOT,
      ".claude-plugin",
      "marketplace.json",
    );
    const entry = market.plugins.find((p) => p.name === manifest.name);
    expect(entry?.source).toBe("./plugins/imsg-mcp");
    expect(entry?.description).toBe(manifest.description);
  });
});
