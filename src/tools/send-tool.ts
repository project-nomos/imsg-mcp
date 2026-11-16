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
        "Sends a real iMessage/SMS from the owner's number to a phone number, email or existing chat: text, a file, or both. The file is either an attachment from a message (attachment_id, to forward it) or a new file you write (file). The server delivers only to recipients on its allowlist and enforces a length limit, file rules (files must be turned on; no programs or archives) and a rate limit; the result says whether the sent message was confirmed in history. Each call is a destructive action that the client asks the user to approve.",
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
          .optional()
          .describe(
            "The exact message text the user approved. Up to the server's max_chars (1,000 by default; see get_status). Optional when sending a file.",
          ),
        attachment_id: z
          .string()
          .optional()
          .describe(
            'Send this attachment, for example to forward a photo: the "id" of an entry in a message\'s attachments list. Needs files turned on (get_status: send.files).',
          ),
        file: z
          .object({
            name: z
              .string()
              .optional()
              .describe("File name with an extension, such as invite.ics."),
            text: z
              .string()
              .optional()
              .describe("The content, for a text file (.ics, .vcf, .txt, .csv)."),
            base64: z
              .string()
              .optional()
              .describe("The content, base64-encoded, for any other file."),
          })
          .optional()
          .describe(
            "A new file to send, up to 5 MB: its name and its content as text or base64. Needs files turned on (get_status: send.files).",
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
            attachment_id: args.attachment_id,
            file: args.file,
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
