import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { App } from "../app";
import type { Identity } from "../auth/access";
import { attachmentToolVisible, createMcpServer, sendToolVisible } from "./server";

/**
 * Local mode: MCP over stdin/stdout for a client on the same Mac (Claude Desktop,
 * Claude Code). There is no network listener and no Cloudflare; the caller is the
 * local user with `local.role`. Send rules still apply.
 *
 * Unlike HTTP mode, the session lives on, so a config reload (SIGHUP) shows or hides
 * `send_message` and `get_attachment`, and the client is told the tool list changed.
 */
export async function serveStdio(app: App): Promise<{ close(): Promise<void> }> {
  const identity: Identity = { kind: "local", id: "local", role: app.config.current.local.role };
  const { server, sendTool, attachmentTool } = createMcpServer(app, identity, {
    alwaysRegisterSend: true,
  });
  const unsubscribe = app.config.onChange(() => {
    const show = (tool: typeof attachmentTool | undefined, visible: boolean) => {
      if (!tool) return;
      if (visible && !tool.enabled) tool.enable();
      if (!visible && tool.enabled) tool.disable();
    };
    show(sendTool, sendToolVisible(app, identity));
    show(attachmentTool, attachmentToolVisible(app));
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    close: async () => {
      unsubscribe();
      await server.close();
    },
  };
}
