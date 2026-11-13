import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../imsg/status";
import { DEFAULT_LAUNCHD_LABEL } from "../paths";

/** The command that runs this program again: the binary itself, or bun plus the script. */
export function selfCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/");
  return compiled ? [process.execPath] : [process.execPath, Bun.main];
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PASSTHROUGH_ENV = ["PATH", "IMSG_MCP_CONFIG", "IMSG_MCP_STATE_DIR", "IMSG_MCP_LOG_DIR"];

export function selftestPlist(
  label: string,
  programArgs: string[],
  outFile: string,
  env: NodeJS.ProcessEnv,
): string {
  const envEntries = PASSTHROUGH_ENV.filter((k) => env[k])
    .map((k) => `    <key>${k}</key>\n    <string>${xml(env[k]!)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(outFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(outFile)}</string>
</dict>
</plist>
`;
}

/**
 * Runs `imsg-mcp selftest` as a one-shot LaunchAgent in the current user's GUI session.
 *
 * macOS checks privacy permissions against the "responsible" process. Started from a
 * terminal, that is the terminal app, so a plain `imsg-mcp selftest` tests the terminal's
 * Full Disk Access. Started by launchd, the binary is its own responsible process, just
 * like the running service, so this tests the grants the service actually uses.
 */
export async function runSelftestViaLaunchd(
  forwardArgs: string[],
  out: (line: string) => void,
  timeoutMs: number,
): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd mode needs macOS");
  const label = `${DEFAULT_LAUNCHD_LABEL}.selftest.${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), "imsg-mcp-selftest-"));
  const outFile = join(dir, "selftest.log");
  const plistPath = join(dir, `${label}.plist`);
  const programArgs = [...selfCommand(), "selftest", ...forwardArgs];
  writeFileSync(plistPath, selftestPlist(label, programArgs, outFile, process.env), {
    mode: 0o600,
  });
  writeFileSync(outFile, "", { mode: 0o600 });

  const domain = `gui/${uid}`;
  const boot = await runCommand(["/bin/launchctl", "bootstrap", domain, plistPath], 15_000);
  if (boot.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `launchctl bootstrap ${domain} failed (${boot.stderr.trim() || `exit ${boot.code}`}). ` +
        `Run this as the bot user inside its logged-in session (for example over Screen Sharing).`,
    );
  }
  out(
    `Running the selftest under launchd as ${label} (so macOS checks imsg-mcp's own permissions)…`,
  );
  try {
    const deadline = Date.now() + timeoutMs;
    let shown = 0;
    let result: boolean | undefined;
    while (Date.now() < deadline) {
      const text = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
      const lines = text.split("\n");
      const resultLine = lines.find((l) => l.startsWith("Result:"));
      // Print complete lines as they arrive (all of them once the result is in).
      const printable = resultLine ? lines.length : lines.length - 1;
      for (; shown < printable; shown++) if (lines[shown]) out(lines[shown]!);
      if (resultLine) {
        result = resultLine.startsWith("Result: PASS");
        break;
      }
      await Bun.sleep(250);
    }
    if (result === undefined) {
      out(`Result: FAIL (no result from the launchd job within ${Math.round(timeoutMs / 1000)}s)`);
      return false;
    }
    return result;
  } finally {
    await runCommand(["/bin/launchctl", "bootout", `${domain}/${label}`], 15_000).catch(
      () => undefined,
    );
    rmSync(dir, { recursive: true, force: true });
  }
}
