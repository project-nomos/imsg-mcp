import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runTool, type ToolContext } from "./context";

/**
 * `send_message`. Registered only when `send.enabled` is true and the caller's role
 * includes send, so a read-only setup cannot send even by mistake. The server still
 * re-checks every rule on each call.
 */
export function registerSendTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    "send_message",
    {
      title: "Send a text message",
      description:
        "Sends a real iMessage/SMS from the owner's number to a phone number, email or existing chat. The server delivers only to recipients on its allowlist and enforces a length limit and a rate limit; the result says whether the sent message was confirmed in history. Each call is a destructive action that the client asks the user to approve.",
      // Deliberately loose: the send service validates everything, so every call reaches it
      // and is audited, including malformed ones.
      inputSchema: {
        to: z
          .string()
          .optional()
          .describe(
            "Recipient as an E.164 phone number (+14155550123) or email. Give either `to` or `chat_id`.",
          ),
        chat_id: z
          .number()
          .optional()
          .describe(
            "Existing chat id from list_chats (works for group chats). Give either `to` or `chat_id`.",
          ),
        text: z
          .string()
          .describe(
            "The exact message text the user approved. Up to the server's max_chars (1,000 by default; see get_status).",
          ),
      },
      annotations: {
        title: "Send a text message",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) =>
      runTool(
        ctx,
        "send_message",
        async () => {
          const outcome = await ctx.app.sender.send(ctx.identity, {
            to: args.to,
            chat_id: args.chat_id,
            text: args.text,
          });
          const note =
            outcome.status === "sent"
              ? "Delivered to Messages and found in history."
              : "Messages accepted the send, but the sent message did not show up in history within the check window. It is most likely on its way; check get_messages before sending again.";
          return { result: { ...outcome, note } };
        },
        // SendService writes the before/after audit records itself.
        { audit: false },
      ),
  );
}
