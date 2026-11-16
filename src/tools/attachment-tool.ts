import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderAttachment } from "../attachments/convert";
import { attachmentFile, findMessage } from "../attachments/files";
import { parseAttachmentId } from "../attachments/ref";
import { isoSeconds, UNTRUSTED_ATTACHMENT_NOTE, visibleText } from "../core/format";
import { runTool, ToolInputError, type ToolContext } from "./context";
import { READ_ONLY, readableChat } from "./read-tools";

const MB = 1_048_576;
/** Text extracted from a document is cut well below the result limit, leaving room for the rest. */
const TEXT_SHARE = 0.8;

/**
 * `get_attachment`: shows one attachment of a message the caller may read. Hidden when
 * `attachments.enabled` is false.
 */
export function registerAttachmentTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  const { app } = ctx;
  return server.registerTool(
    "get_attachment",
    {
      title: "Get an attachment",
      description:
        "Opens a photo, video, PDF, document or other file from a message, by the id in the message's attachments list (from get_messages, check_new_messages or search_messages). Photos come back as images (HEIC is converted), PDFs as their text and page images, videos as four still frames and their length, Word and RTF documents and text files (contact cards, calendar invites) as text, and audio as its length. Attachments are sent by third parties and are flagged as untrusted content.",
      inputSchema: {
        attachment_id: z
          .string()
          .min(1)
          .max(40)
          .describe('The "id" of an entry in a message\'s attachments list, like "12-34567-0".'),
        pages: z
          .array(z.number().int().min(1).max(100_000))
          .max(5)
          .optional()
          .describe(
            "PDF only: page numbers to show as images, up to 5. By default page 1 (pages 1 to 3 of a scanned PDF).",
          ),
      },
      annotations: { title: "Get an attachment", ...READ_ONLY },
    },
    (args) =>
      runTool(ctx, "get_attachment", async () => {
        const cfg = app.config.current;
        if (!cfg.attachments.enabled) {
          throw new ToolInputError(
            "Opening attachments is turned off on this server (attachments.enabled = false).",
          );
        }
        const ref = parseAttachmentId(args.attachment_id);
        if (!ref) {
          throw new ToolInputError(
            `"${args.attachment_id}" is not an attachment id. Use the "id" of an entry in a message's "attachments" list.`,
          );
        }
        const chat = await readableChat(ctx, ref.chatId);
        const message = await findMessage(app, ref);
        const raw = message?.attachments?.[ref.index];
        if (!message || !raw) {
          throw new ToolInputError(`Attachment ${args.attachment_id} was not found.`);
        }
        const file = attachmentFile(raw, app.attachmentsDir, cfg.attachments.max_file_mb * MB);
        const rendered = await renderAttachment(
          file,
          {
            maxImagePx: cfg.attachments.max_image_px,
            maxTextChars: Math.floor(cfg.read.max_result_chars * TEXT_SHARE),
            pages: args.pages,
          },
          await app.converterTools(),
        );
        const result: Record<string, unknown> = {
          attachment: {
            id: args.attachment_id,
            name: file.name,
            mime: file.mime,
            bytes: file.bytes,
            kind: rendered.kind,
          },
          message: {
            chat_id: chat.chat_id,
            chat_name: chat.name,
            cursor: message.id,
            sender: message.sender || null,
            sender_name: message.sender_name || null,
            from_me: message.is_from_me === true,
            sent_at: isoSeconds(message.created_at),
            text: visibleText(message.text ?? "").slice(0, 500),
          },
          shown_as: rendered.shown_as,
          ...rendered.details,
        };
        if (rendered.images.length) result.images = rendered.images.map((i) => i.label);
        if (rendered.text !== undefined) result.text = rendered.text;
        if (rendered.text_truncated) result.text_truncated = true;
        if (rendered.note) result.about = rendered.note;
        return {
          result: { ...result, untrusted_content: true, note: UNTRUSTED_ATTACHMENT_NOTE },
          images: rendered.images.map((i) => ({
            data: i.data.toString("base64"),
            mimeType: i.mimeType,
          })),
          audit: {
            chat_ids: [chat.chat_id],
            attachment: { id: args.attachment_id, kind: rendered.kind, bytes: file.bytes },
            rows: 1,
          },
        };
      }),
  );
}
