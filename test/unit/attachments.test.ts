import { describe, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  NO_CONVERTER_TOOLS,
  renderAttachment,
  sandboxProfile,
  systemConverterTools,
  type AttachmentFile,
  type ConverterTools,
} from "../../src/attachments/convert";
import { AttachmentError, attachmentFile } from "../../src/attachments/files";
import { attachmentKind, SENDABLE_EXTENSIONS } from "../../src/attachments/kinds";
import { formatAttachmentId, parseAttachmentId } from "../../src/attachments/ref";
import { tempDir } from "../helpers/harness";
import { minimalPdf, PNG_1X1, wav } from "../helpers/media";

const MAC = process.platform === "darwin";
const opts = { maxImagePx: 1568, maxTextChars: 10_000 };

function fileAt(path: string, name: string, mime: string | null, uti: string | null = null) {
  return { path, name, mime, uti, bytes: readFileSync(path).length } satisfies AttachmentFile;
}

describe("attachment kinds", () => {
  test("come from the MIME type, then the type identifier, then the extension", () => {
    expect(attachmentKind({ mime: "image/heic" })).toBe("image");
    expect(attachmentKind({ mime: "application/pdf" })).toBe("pdf");
    expect(attachmentKind({ mime: "video/quicktime" })).toBe("video");
    expect(attachmentKind({ mime: "audio/x-caf" })).toBe("audio");
    expect(attachmentKind({ mime: "text/vcard" })).toBe("text");
    expect(attachmentKind({ mime: "text/html" })).toBe("document");
    expect(
      attachmentKind({
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe("document");
    expect(attachmentKind({ mime: null, uti: "com.adobe.pdf" })).toBe("pdf");
    expect(attachmentKind({ mime: "", name: "IMG_1.HEIC" })).toBe("image");
    expect(attachmentKind({ name: "Contact.vcf" })).toBe("text");
    expect(attachmentKind({ name: "payload.pluginPayloadAttachment" })).toBe("other");
  });

  test("programs, scripts and archives cannot be sent", () => {
    for (const ext of [
      "app",
      "command",
      "sh",
      "zip",
      "dmg",
      "pkg",
      "exe",
      "js",
      "scpt",
      "doc",
      "xls",
      "ppt",
    ]) {
      expect(SENDABLE_EXTENSIONS.has(ext)).toBe(false);
    }
    for (const ext of ["jpg", "heic", "pdf", "mov", "ics", "vcf", "docx"]) {
      expect(SENDABLE_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});

describe("attachment ids", () => {
  test("round-trip and reject anything else", () => {
    expect(formatAttachmentId(12, 34567, 0)).toBe("12-34567-0");
    expect(parseAttachmentId("12-34567-0")).toEqual({ chatId: 12, rowid: 34567, index: 0 });
    for (const bad of [
      "",
      "12-34567",
      "a-1-0",
      "0-1-0",
      "12-0-0",
      "1-2-3-4",
      "1-2-1000",
      "../1-2-0",
    ]) {
      expect(parseAttachmentId(bad)).toBeUndefined();
    }
  });
});

describe("attachment files", () => {
  const root = tempDir("imsg-mcp-attach-root-");
  const outside = tempDir("imsg-mcp-attach-outside-");
  mkdirSync(join(root, "ab"));
  writeFileSync(join(root, "ab", "photo.jpg"), "jpeg");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(root, "ab", "link.txt"));
  const raw = (path: string, extra: Record<string, unknown> = {}) => ({
    original_path: path,
    transfer_name: path.split("/").pop(),
    mime_type: "image/jpeg",
    ...extra,
  });

  test("opens a regular file inside the attachments folder", () => {
    const f = attachmentFile(raw(join(root, "ab", "photo.jpg")), root, 1_000);
    expect(f).toMatchObject({ name: "photo.jpg", mime: "image/jpeg", bytes: 4 });
  });

  test("refuses files outside the folder, also through a symlink or ..", () => {
    expect(() => attachmentFile(raw(join(outside, "secret.txt")), root, 1_000)).toThrow(
      /outside the Messages attachments folder/,
    );
    expect(() => attachmentFile(raw(join(root, "ab", "link.txt")), root, 1_000)).toThrow(
      /outside the Messages attachments folder/,
    );
    expect(() =>
      attachmentFile(
        raw(join(root, "ab", "..", "..", outside.split("/").pop()!, "secret.txt")),
        root,
        1_000,
      ),
    ).toThrow(AttachmentError);
  });

  test("reports missing, oversized and non-file attachments", () => {
    expect(() => attachmentFile(raw("", { missing: true }), root, 1_000)).toThrow(
      /not on this Mac/,
    );
    expect(() => attachmentFile(raw(join(root, "ab", "gone.jpg")), root, 1_000)).toThrow(
      /not on this Mac/,
    );
    expect(() => attachmentFile(raw(join(root, "ab", "photo.jpg")), root, 3)).toThrow(
      /the limit is/,
    );
    expect(() => attachmentFile(raw(join(root, "ab")), root, 1_000)).toThrow(/not a file/);
  });
});

describe("the converter sandbox", () => {
  test("refuses paths that could break out of the profile", () => {
    const base = {
      home: "/Users/me",
      work: "/private/tmp/w",
      temp: "/private/tmp",
      tool: "/usr/bin/sips",
    };
    expect(() => sandboxProfile({ ...base, work: '/tmp/a") (allow default' })).toThrow();
    expect(() => sandboxProfile({ ...base, tool: "relative/sips" })).toThrow();
    const profile = sandboxProfile(base);
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny appleevent-send)");
    expect(profile).toContain('(deny file-read* (subpath "/Users/me"))');
    expect(profile).toContain('(allow process-exec (literal "/usr/bin/sips"))');
  });

  test.skipIf(!MAC)(
    "blocks home reads, outside writes, other programs and the network",
    async () => {
      // The sandbox matches real paths (/private/var/..., not /var/...), as the server passes them.
      const home = realpathSync(tempDir("imsg-mcp-sb-home-"));
      const work = realpathSync(tempDir("imsg-mcp-sb-work-"));
      writeFileSync(join(home, "secret.txt"), "secret");
      writeFileSync(join(work, "ok.txt"), "ok");
      const run = async (tool: string, args: string[]) => {
        const profile = sandboxProfile({ home, work, temp: work, tool });
        const p = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, tool, ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });
        return { code: await p.exited, out: await new Response(p.stdout).text() };
      };
      expect(await run("/bin/cat", [join(work, "ok.txt")])).toEqual({ code: 0, out: "ok" });
      expect((await run("/bin/cat", [join(home, "secret.txt")])).code).not.toBe(0);
      expect((await run("/usr/bin/touch", [join(home, "new.txt")])).code).not.toBe(0);
      expect((await run("/usr/bin/touch", [join(work, "new.txt")])).code).toBe(0);
      expect((await run("/usr/bin/curl", ["-sS", "-m", "5", "https://example.com"])).code).not.toBe(
        0,
      );
      // Only the named tool may run: sandbox-exec cannot start anything else.
      const profile = sandboxProfile({ home, work, temp: work, tool: "/usr/bin/sips" });
      const other = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/bin/ls"], {
        stderr: "pipe",
      });
      expect(await other.exited).not.toBe(0);
    },
  );
});

describe("rendering without converters (Linux, the demo container)", () => {
  const dir = tempDir("imsg-mcp-render-");

  test("text files come back as text", async () => {
    const path = join(dir, "card.vcf");
    writeFileSync(path, "BEGIN:VCARD\r\nFN:Alice\r\nEND:VCARD\r\n");
    const r = await renderAttachment(
      fileAt(path, "card.vcf", "text/vcard"),
      opts,
      NO_CONVERTER_TOOLS,
    );
    expect(r).toMatchObject({ kind: "text", shown_as: "text", images: [] });
    expect(r.text).toBe("BEGIN:VCARD\nFN:Alice\nEND:VCARD\n");
    const cut = await renderAttachment(
      fileAt(path, "card.vcf", "text/vcard"),
      { ...opts, maxTextChars: 5 },
      NO_CONVERTER_TOOLS,
    );
    expect(cut).toMatchObject({ text: "BEGIN", text_truncated: true });
  });

  test("binary data posing as text is not shown", async () => {
    const path = join(dir, "fake.txt");
    writeFileSync(path, Buffer.from([0x41, 0x00, 0x42]));
    const r = await renderAttachment(
      fileAt(path, "fake.txt", "text/plain"),
      opts,
      NO_CONVERTER_TOOLS,
    );
    expect(r.text).toBeUndefined();
    expect(r.note).toContain("not plain text");
  });

  test("PNG and JPEG pass through; HEIC and PDFs need macOS", async () => {
    const png = join(dir, "dot.png");
    writeFileSync(png, PNG_1X1);
    const r = await renderAttachment(fileAt(png, "dot.png", "image/png"), opts, NO_CONVERTER_TOOLS);
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.mimeType).toBe("image/png");
    expect(r.images[0]!.data.equals(PNG_1X1)).toBe(true);

    const heic = join(dir, "photo.heic");
    writeFileSync(heic, "not really heic");
    const h = await renderAttachment(
      fileAt(heic, "photo.heic", "image/heic"),
      opts,
      NO_CONVERTER_TOOLS,
    );
    expect(h.images).toHaveLength(0);
    expect(h.note).toContain("needs macOS");

    const pdf = join(dir, "doc.pdf");
    writeFileSync(pdf, minimalPdf("Hello"));
    const p = await renderAttachment(
      fileAt(pdf, "doc.pdf", "application/pdf"),
      opts,
      NO_CONVERTER_TOOLS,
    );
    expect(p).toMatchObject({ kind: "pdf", shown_as: "details only", images: [] });
  });
});

describe("rendering with converters (fakes)", () => {
  const dir = tempDir("imsg-mcp-render-fake-");
  const calls: string[] = [];
  /** Converters that write their fixed output names and record how they were called. */
  const fake: ConverterTools = {
    available: true,
    imageSize: async () => ({ width: 4032, height: 3024 }),
    convertImage: async (_in, output, work, o) => {
      calls.push(`image ${o.format} ${o.maxPx ?? "-"}`);
      writeFileSync(join(work, output), "converted");
      return true;
    },
    pdf: async (_in, work, pages) => {
      calls.push(`pdf ${pages.join(",")}`);
      for (const page of pages) writeFileSync(join(work, `page-${page}.jpg`), `page ${page}`);
      writeFileSync(join(work, "text.txt"), "");
      return { pages: 7, text_length: 0 };
    },
    media: async (_in, work, frames) => {
      calls.push(`media ${frames}`);
      if (frames) writeFileSync(join(work, "frame-0.jpg"), "frame");
      // Frames it did not write, or past the count asked for, are ignored.
      const listed = [
        { index: 0, at: 1.6 },
        { index: 2, at: 3 },
        { index: 9, at: 4 },
      ];
      return { duration_seconds: 12.5, has_video: frames > 0, frames: frames ? listed : [] };
    },
    documentText: async (_in, work) => {
      writeFileSync(join(work, "document.txt"), "  Text of the doc  ");
      return true;
    },
  };
  const file = (name: string, mime: string) => {
    const path = join(dir, name);
    writeFileSync(path, "x");
    return fileAt(path, name, mime);
  };

  test("a large HEIC photo becomes a JPEG scaled to max_image_px", async () => {
    calls.length = 0;
    const r = await renderAttachment(file("IMG.HEIC", "image/heic"), opts, fake);
    expect(calls).toEqual(["image jpeg 1568"]);
    expect(r.images[0]).toMatchObject({ mimeType: "image/jpeg" });
    expect(r.details).toMatchObject({ width: 1568, height: 1176, converted_from: "heic" });
  });

  test("a scanned PDF shows its first three pages; asked-for pages win", async () => {
    calls.length = 0;
    const r = await renderAttachment(file("scan.pdf", "application/pdf"), opts, fake);
    expect(calls).toEqual(["pdf 1", "pdf 1,2,3"]);
    expect(r.images.map((i) => i.label)).toEqual(["page 1", "page 2", "page 3"]);
    expect(r.shown_as).toBe("page images (no text layer)");
    expect(r.note).toContain('Pass "pages"');
    calls.length = 0;
    const asked = await renderAttachment(
      file("scan.pdf", "application/pdf"),
      { ...opts, pages: [5, 7] },
      fake,
    );
    expect(calls).toEqual(["pdf 5,7"]);
    expect(asked.images.map((i) => i.label)).toEqual(["page 5", "page 7"]);
  });

  test("videos give the frames that were written; audio gives its length", async () => {
    const v = await renderAttachment(file("clip.mov", "video/quicktime"), opts, fake);
    expect(v.images.map((i) => i.label)).toEqual(["frame at 1.6 s"]);
    expect(v.details).toMatchObject({ duration_seconds: 12.5, frames_at_seconds: [1.6] });
    const a = await renderAttachment(file("voice.caf", "audio/x-caf"), opts, fake);
    expect(a).toMatchObject({ kind: "audio", images: [], details: { duration_seconds: 12.5 } });
  });

  test("documents come back as text", async () => {
    const d = await renderAttachment(file("notes.docx", "application/msword"), opts, fake);
    expect(d).toMatchObject({ kind: "document", text: "Text of the doc" });
  });

  test("links a converter plants in the work folder are not followed", async () => {
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "the secret");
    const planted: ConverterTools = {
      ...fake,
      pdf: async (_in, work) => {
        symlinkSync(secret, join(work, "page-1.jpg"));
        symlinkSync(secret, join(work, "text.txt"));
        return { pages: 1, text_length: 10 };
      },
      media: async (_in, work) => {
        linkSync(secret, join(work, "frame-0.jpg")); // a hard link: same file, two names
        return { duration_seconds: 1, has_video: true, frames: [{ index: 0, at: 0.5 }] };
      },
      documentText: async (_in, work) => {
        linkSync(secret, join(work, "document.txt"));
        return true;
      },
    };
    const rendered = [
      await renderAttachment(file("a.pdf", "application/pdf"), opts, planted),
      await renderAttachment(file("b.mov", "video/quicktime"), opts, planted),
      await renderAttachment(file("c.docx", "application/msword"), opts, planted),
    ];
    for (const r of rendered) {
      expect(r.images).toEqual([]);
      expect(r.text ?? "").not.toContain("the secret");
    }
  });

  test("a converter that fails or hangs leaves the details and a note", async () => {
    const failing: ConverterTools = {
      ...fake,
      media: async () => {
        throw new Error("/usr/bin/sandbox-exec timed out after 30000 ms");
      },
      documentText: async () => {
        throw new Error("boom");
      },
    };
    const v = await renderAttachment(file("d.mov", "video/quicktime"), opts, failing);
    expect(v).toMatchObject({ shown_as: "details only", images: [] });
    expect(v.note).toContain("took too long");
    const d = await renderAttachment(file("e.docx", "application/msword"), opts, failing);
    expect(d.note).toContain("could not be converted");
  });
});

describe.skipIf(!MAC)("rendering with the macOS converters (sandboxed)", () => {
  const dir = tempDir("imsg-mcp-render-mac-");
  const tools = systemConverterTools(homedir());
  const sips = (args: string[]) => Bun.spawnSync(["/usr/bin/sips", ...args], { stdout: "ignore" });
  const big = join(dir, "big.png");
  writeFileSync(join(dir, "dot.png"), PNG_1X1);
  sips(["-z", "2400", "3200", join(dir, "dot.png"), "--out", big]);
  sips(["-s", "format", "heic", big, "--out", join(dir, "photo.heic")]);

  test("a HEIC photo comes back as a scaled JPEG", async () => {
    const r = await renderAttachment(
      fileAt(join(dir, "photo.heic"), "photo.heic", "image/heic"),
      opts,
      await tools,
    );
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.mimeType).toBe("image/jpeg");
    expect(r.images[0]!.data.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(r.details).toMatchObject({ width: 1568, height: 1176, original_width: 3200 });
  });

  test("a small PNG passes through unchanged", async () => {
    const r = await renderAttachment(
      fileAt(join(dir, "dot.png"), "dot.png", "image/png"),
      opts,
      await tools,
    );
    expect(r.images[0]!.data.equals(PNG_1X1)).toBe(true);
  });

  test("a PDF gives its text and an image of page 1", async () => {
    const path = join(dir, "ticket.pdf");
    writeFileSync(path, minimalPdf("Boarding pass SFO to JFK"));
    const r = await renderAttachment(
      fileAt(path, "ticket.pdf", "application/pdf"),
      opts,
      await tools,
    );
    expect(r.text).toContain("Boarding pass SFO to JFK");
    expect(r.details).toMatchObject({ pages: 1, pages_shown: [1] });
    expect(r.images.map((i) => i.label)).toEqual(["page 1"]);
  });

  test("a video gives four frames and its length", async () => {
    const path = join(import.meta.dir, "..", "fixtures", "media", "clip.mov");
    const r = await renderAttachment(
      fileAt(path, "clip.mov", "video/quicktime"),
      opts,
      await tools,
    );
    expect(r.images).toHaveLength(4);
    expect(r.details).toMatchObject({ duration_seconds: 2 });
  });

  test("an HTML attachment loads nothing from the network", async () => {
    const hits: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return new Response("x");
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const path = join(dir, "page.html");
      writeFileSync(
        path,
        `<html><head><link rel="stylesheet" href="${url}/css"></head><body>Hello<img src="${url}/img"></body></html>`,
      );
      const r = await renderAttachment(fileAt(path, "page.html", "text/html"), opts, await tools);
      expect(r.text).toContain("Hello");
      await Bun.sleep(300);
      expect(hits).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("audio gives its length; RTF gives its text", async () => {
    const audio = join(dir, "voice.wav");
    writeFileSync(audio, wav(1.5));
    const a = await renderAttachment(fileAt(audio, "voice.wav", "audio/wav"), opts, await tools);
    expect(a.details).toEqual({ duration_seconds: 1.5 });
    const rtf = join(dir, "note.rtf");
    writeFileSync(rtf, "{\\rtf1\\ansi Dinner at {\\b eight}.}");
    const d = await renderAttachment(fileAt(rtf, "note.rtf", "text/rtf"), opts, await tools);
    expect(d.text).toBe("Dinner at eight.");
  });
});
