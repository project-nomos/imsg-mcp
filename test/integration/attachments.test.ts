import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildConfig } from "../../src/config/schema";
import { UNTRUSTED_ATTACHMENT_NOTE } from "../../src/core/format";
import { ALICE, CAROL, STRANGER } from "../helpers/fixtures";
import {
  accessKeys,
  baseConfig,
  connectClient,
  Harness,
  OWNER,
  parseToolText,
  toolText,
  waitFor,
} from "../helpers/harness";
import { PNG_1X1 } from "../helpers/media";

const VCARD = "BEGIN:VCARD\nVERSION:3.0\nFN:Alice Example\nTEL:+14155550101\nEND:VCARD\n";
const INVITE = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Dinner\nEND:VEVENT\nEND:VCALENDAR\n";

interface Content {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

// Both lookup paths: imsg 0.21 reads a message by rowid (messages.after); 0.8.2 has no
// such method, so the server finds the message through history.
for (const version of ["0.8.2", "0.21.0"] as const) {
  describe(`attachments with imsg ${version}`, () => {
    let h: Harness;
    let owner: Client;

    beforeAll(async () => {
      const keys = await accessKeys();
      h = await new Harness({ keySource: keys.keySource, version }).start();
      owner = await connectClient(await h.startHttp(), await keys.sign({ email: OWNER }));
    });

    afterAll(async () => {
      await owner?.close();
      await h?.stop();
    });

    const call = (name: string, args: Record<string, unknown>) =>
      owner.callTool({ name, arguments: args });
    const setConfig = (overrides: Record<string, unknown>) =>
      h.config.set(buildConfig(baseConfig(overrides)));

    test("messages list each attachment with an id, and no placeholder text", async () => {
      const rowid = h.injectAttachment({
        chat_id: 1,
        sender: ALICE,
        name: "Alice.vcf",
        content: VCARD,
        mime: "text/vcard",
      });
      const res = parseToolText(await call("get_messages", { chat_id: 1 }));
      const msg = (res.messages as { cursor: number; text: string; attachments: unknown[] }[]).find(
        (m) => m.cursor === rowid,
      )!;
      expect(msg.text).toBe("");
      expect(msg.attachments).toEqual([
        { id: `1-${rowid}-0`, name: "Alice.vcf", mime: "text/vcard", bytes: VCARD.length },
      ]);
      // New messages carry the same ids.
      const fresh = await waitFor(async () => {
        const r = parseToolText(await call("check_new_messages", {}));
        return (r.messages as { cursor: number; attachments: { id: string }[] }[]).find(
          (m) => m.cursor === rowid,
        );
      });
      expect(fresh.attachments[0]!.id).toBe(`1-${rowid}-0`);
    });

    test("a contact card comes back as text, flagged untrusted; the audit has no content", async () => {
      const rowid = h.injectAttachment({
        chat_id: 1,
        sender: ALICE,
        text: "My new number",
        name: "Alice.vcf",
        content: VCARD,
        mime: "text/vcard",
      });
      const id = `1-${rowid}-0`;
      const res = await call("get_attachment", { attachment_id: id });
      expect(res.isError).toBeFalsy();
      const body = parseToolText(res);
      expect(body).toMatchObject({
        attachment: { id, name: "Alice.vcf", mime: "text/vcard", kind: "text" },
        message: {
          chat_id: 1,
          cursor: rowid,
          sender: ALICE,
          from_me: false,
          text: "My new number",
        },
        shown_as: "text",
        text: VCARD,
        untrusted_content: true,
        note: UNTRUSTED_ATTACHMENT_NOTE,
      });
      const record = h.audit.records.at(-1)!;
      expect(record).toMatchObject({
        tool: "get_attachment",
        status: "ok",
        chat_ids: [1],
        attachment: { id, kind: "text", bytes: VCARD.length },
      });
      expect(JSON.stringify(record)).not.toContain("Alice Example");
    });

    test("a photo comes back as an image", async () => {
      const rowid = h.injectAttachment({
        chat_id: 1,
        sender: ALICE,
        name: "dot.png",
        content: PNG_1X1,
        mime: "image/png",
      });
      const res = await call("get_attachment", { attachment_id: `1-${rowid}-0` });
      const content = res.content as Content[];
      expect(content.map((c) => c.type)).toEqual(["text", "image"]);
      expect(content[1]).toMatchObject({ mimeType: "image/png", data: PNG_1X1.toString("base64") });
      expect(parseToolText(res)).toMatchObject({ shown_as: "image", images: ["the image"] });
    });

    test("refuses bad ids, unknown or missing attachments, and files outside the folder", async () => {
      const bad = await call("get_attachment", { attachment_id: "photo.jpg" });
      expect(toolText(bad)).toContain("is not an attachment id");
      const unknown = await call("get_attachment", { attachment_id: "1-999999-0" });
      expect(toolText(unknown)).toContain("was not found");

      const missing = h.injectAttachment({
        chat_id: 1,
        name: "old.mov",
        content: "",
        mime: "video/quicktime",
        missing: true,
      });
      expect(toolText(await call("get_attachment", { attachment_id: `1-${missing}-0` }))).toContain(
        "not on this Mac",
      );
      expect(toolText(await call("get_attachment", { attachment_id: `1-${missing}-3` }))).toContain(
        "was not found",
      );

      // A database row pointing anywhere else on the Mac is never opened.
      const outside = h.injectAttachment({
        chat_id: 1,
        name: "secrets.txt",
        content: "do not read",
        mime: "text/plain",
        path: join(h.dir, "elsewhere", "secrets.txt"),
      });
      const res = await call("get_attachment", { attachment_id: `1-${outside}-0` });
      expect(res.isError).toBe(true);
      expect(toolText(res)).toContain("outside the Messages attachments folder");
      expect(toolText(res)).not.toContain("do not read");
    });

    test("the read scope applies to attachments", async () => {
      const rowid = h.injectAttachment({
        chat_id: 4,
        sender: CAROL,
        name: "notes.txt",
        content: "private",
        mime: "text/plain",
      });
      setConfig({ read: { scope: [ALICE] } });
      try {
        const res = await call("get_attachment", { attachment_id: `4-${rowid}-0` });
        expect(toolText(res)).toContain("outside the read scope");
      } finally {
        setConfig({});
      }
    });

    test("forwards an attachment once sending files is on", async () => {
      const rowid = h.injectAttachment({
        chat_id: 4,
        sender: CAROL,
        name: "dot.png",
        content: PNG_1X1,
        mime: "image/png",
      });
      const id = `4-${rowid}-0`;
      const off = await call("send_message", { to: ALICE, attachment_id: id });
      expect(toolText(off)).toContain("rule 3 (file): sending files is turned off");
      expect(h.audit.records.at(-1)).toMatchObject({
        status: "refused",
        rule: "file",
        file: { attachment_id: id },
      });

      setConfig({ send: { files: true, rate: "100/hour" } });
      try {
        const before = h.audit.records.length;
        const res = parseToolText(await call("send_message", { to: ALICE, attachment_id: id }));
        expect(res).toMatchObject({
          status: "sent",
          chat_id: 1,
          file: { name: "dot.png", bytes: PNG_1X1.length },
        });
        // imsg got the file and staged its own copy; the copy is the original.
        const sent = h.readDb().messages.find((m) => m.id === res.cursor) as {
          is_from_me: boolean;
          attachments: { filename: string; transfer_name: string }[];
        };
        expect(sent.is_from_me).toBe(true);
        expect(sent.attachments[0]!.transfer_name).toBe("dot.png");
        expect(readFileSync(sent.attachments[0]!.filename).equals(PNG_1X1)).toBe(true);
        const [record] = h.audit.records.slice(before);
        expect(record).toMatchObject({
          phase: "before",
          rule: "passed",
          file: {
            name: "dot.png",
            bytes: PNG_1X1.length,
            sha256: createHash("sha256").update(PNG_1X1).digest("hex"),
            source: "attachment",
            attachment_id: id,
          },
        });
        expect(record!.text).toBeUndefined();
        expect(JSON.stringify(record)).not.toContain(PNG_1X1.toString("base64"));
      } finally {
        setConfig({});
      }
    });
  });
}

describe("sending new files", () => {
  let h: Harness;
  let owner: Client;

  beforeAll(async () => {
    const keys = await accessKeys();
    h = await new Harness({ keySource: keys.keySource, version: "0.21.0" }).start();
    owner = await connectClient(await h.startHttp(), await keys.sign({ email: OWNER }));
    h.config.set(buildConfig(baseConfig({ send: { files: true, rate: "100/hour" } })));
  });

  afterAll(async () => {
    await owner?.close();
    await h?.stop();
  });

  const send = (args: Record<string, unknown>) =>
    owner.callTool({ name: "send_message", arguments: { to: ALICE, ...args } });

  test("text and a calendar invite go out as two messages, text first", async () => {
    const res = parseToolText(
      await send({ text: "Invite attached", file: { name: "dinner.ics", text: INVITE } }),
    );
    expect(res).toMatchObject({
      status: "sent",
      file: { name: "dinner.ics", bytes: INVITE.length },
    });
    const mine = h
      .readDb()
      .messages.filter((m) => m.is_from_me)
      .slice(-2) as {
      text: string;
      attachments?: { filename: string; transfer_name: string }[];
    }[];
    expect(mine[0]!.text).toBe("Invite attached");
    expect(mine[1]!.attachments![0]!.transfer_name).toBe("dinner.ics");
    expect(readFileSync(mine[1]!.attachments![0]!.filename, "utf8")).toBe(INVITE);
    expect(h.audit.records.find((r) => r.phase === "before" && r.rule === "passed")).toMatchObject({
      text: "Invite attached",
      file: { name: "dinner.ics", source: "new" },
    });
  });

  test("a base64 file is decoded; a file alone is confirmed by its name", async () => {
    const res = parseToolText(
      await send({ file: { name: "dot.png", base64: PNG_1X1.toString("base64") } }),
    );
    expect(res).toMatchObject({ status: "sent", file: { name: "dot.png", bytes: PNG_1X1.length } });
    const row = h.readDb().messages.find((m) => m.id === res.cursor) as {
      attachments: { filename: string }[];
    };
    expect(readFileSync(row.attachments[0]!.filename).equals(PNG_1X1)).toBe(true);
  });

  test("refuses programs, archives, bad names, bad base64, empty and oversized files", async () => {
    const before = h.readDb().messages.length;
    expect(toolText(await send({ file: { name: "run.sh", text: "rm -rf ~" } }))).toContain(
      '".sh" files cannot be sent',
    );
    expect(toolText(await send({ file: { name: "x.zip", base64: "UEsDBA==" } }))).toContain(
      '".zip" files cannot be sent',
    );
    expect(toolText(await send({ file: { name: "../../notes", text: "hi" } }))).toContain(
      "must be a file name with an extension",
    );
    expect(toolText(await send({ file: { name: "a.png", base64: "not base64!" } }))).toContain(
      "not valid base64",
    );
    expect(toolText(await send({ file: { name: "a.txt", text: "" } }))).toContain(
      "the file is empty",
    );
    expect(toolText(await send({ file: { name: "a.txt", text: "x", base64: "eA==" } }))).toContain(
      "exactly one of",
    );
    h.config.set(buildConfig(baseConfig({ send: { files: true, max_file_mb: 1 } })));
    try {
      const big = await send({ file: { name: "big.txt", text: "x".repeat(1_100_000) } });
      expect(toolText(big)).toContain("the limit is 1 MB");
    } finally {
      h.config.set(buildConfig(baseConfig({ send: { files: true, rate: "100/hour" } })));
    }
    expect(h.readDb().messages.length).toBe(before);
  });

  test("base64 without padding, and URL-safe base64, are accepted", async () => {
    const unpadded = PNG_1X1.toString("base64").replace(/=+$/, "");
    expect(parseToolText(await send({ file: { name: "a.png", base64: unpadded } }))).toMatchObject({
      status: "sent",
      file: { bytes: PNG_1X1.length },
    });
    const urlSafe = PNG_1X1.toString("base64url");
    expect(parseToolText(await send({ file: { name: "b.png", base64: urlSafe } })).status).toBe(
      "sent",
    );
  });

  test("a refused send keeps its audit record small", async () => {
    const res = await send({ attachment_id: "9".repeat(100_000) });
    expect(toolText(res)).toContain("is not an attachment id");
    const record = h.audit.records.at(-1)!;
    expect((record.file as { attachment_id: string }).attachment_id).toHaveLength(64);
    expect(JSON.stringify(record).length).toBeLessThan(2_000);
  });

  test("the allowlist still decides who gets a file", async () => {
    const res = await owner.callTool({
      name: "send_message",
      arguments: { to: STRANGER, file: { name: "a.txt", text: "hi" } },
    });
    expect(toolText(res)).toContain("rule 2 (allowlist)");
  });

  test("give either attachment_id or file, not both", async () => {
    const res = await send({ attachment_id: "1-14-0", file: { name: "a.txt", text: "hi" } });
    expect(toolText(res)).toContain("not both");
  });
});
