import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandResult } from "../imsg/status";
import { MEDIA_SCRIPT, PDF_SCRIPT } from "./jxa";
import { attachmentKind, extensionOf, PASSTHROUGH_IMAGE_MIME, type AttachmentKind } from "./kinds";

/** An attachment file the caller already checked: a regular file inside the attachments folder. */
export interface AttachmentFile {
  path: string;
  name: string;
  mime: string | null;
  uti: string | null;
  bytes: number;
}

export interface RenderedImage {
  data: Buffer;
  mimeType: string;
  /** What the image shows, such as "page 2" or "frame at 12.5 s". */
  label: string;
}

/** An attachment turned into what an assistant can read: images and text. */
export interface Rendered {
  kind: AttachmentKind;
  /** How it is shown, in a few words. */
  shown_as: string;
  images: RenderedImage[];
  text?: string;
  text_truncated?: true;
  details: Record<string, unknown>;
  note?: string;
}

export interface RenderOptions {
  /** Longest side of returned images, in pixels. */
  maxImagePx: number;
  /** Most characters of extracted text. */
  maxTextChars: number;
  /** PDF pages to show as images, from 1. Default: page 1, or pages 1 to 3 without a text layer. */
  pages?: number[];
}

interface PdfInfo {
  error?: string;
  pages?: number;
  text_length?: number;
}

interface MediaInfo {
  duration_seconds: number | null;
  has_video: boolean;
  frames: { index: number; at: number }[];
}

/**
 * The programs that read and convert files. On macOS they are system tools run in a
 * sandbox; elsewhere (Linux, the demo container) there are none, and only formats that
 * need no conversion are shown. Each writes its output under a fixed name in the work
 * folder, and the server reads only those names.
 */
export interface ConverterTools {
  readonly available: boolean;
  imageSize(input: string, work: string): Promise<{ width: number; height: number } | undefined>;
  /** Converts `input` to `output` (a file name in `work`). */
  convertImage(
    input: string,
    output: string,
    work: string,
    opts: { maxPx?: number; format: "jpeg" | "png" },
  ): Promise<boolean>;
  /** Writes `page-<n>.jpg` for each page asked for and `text.txt`. */
  pdf(
    input: string,
    work: string,
    pages: number[],
    maxPx: number,
    maxChars: number,
  ): Promise<PdfInfo>;
  /** Writes `frame-<i>.jpg` for a video; reports the length of video and audio. */
  media(input: string, work: string, frames: number, maxPx: number): Promise<MediaInfo>;
  /** Writes the document's text to `document.txt`. */
  documentText(input: string, work: string): Promise<boolean>;
}

/** Largest image sent without conversion where nothing can convert it (Claude's limit is 5 MB of base64). */
const PASSTHROUGH_MAX_BYTES = 3_750_000;
/** On macOS, larger images are re-encoded to keep results small. */
const REENCODE_ABOVE_BYTES = 1_500_000;
/** Largest converted image read back. */
const OUTPUT_IMAGE_MAX_BYTES = 10_000_000;
const VIDEO_FRAMES = 4;
const VIDEO_FRAME_PX = 768;
const PDF_PAGE_PX = 1200;
const MAX_PDF_PAGES = 5;
const TOOL_TIMEOUT_MS = 30_000;

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SIPS = "/usr/bin/sips";
const OSASCRIPT = "/usr/bin/osascript";
const TEXTUTIL = "/usr/bin/textutil";

/** Rejects anything that could break out of a quoted sandbox-profile string. */
function sbPath(p: string): string {
  const unsafe = Array.from(p).some((c) => c === '"' || c === "\\" || c.charCodeAt(0) < 0x20);
  if (!p.startsWith("/") || unsafe) throw new Error("unsupported characters in a path");
  return p;
}

/**
 * The sandbox for one converter run. The tool may read the work folder and the system,
 * but nothing in the home folder (Messages, mail, keys); it may write only to the work
 * folder and the per-user temp folder; it has no network, cannot send Apple Events (so it
 * cannot drive Messages), cannot trigger privacy prompts, and cannot start other programs.
 * The attachment is copied into the work folder first, so its name never appears here.
 * Paths must be real paths (`/private/var/...`, not `/var/...`): the sandbox matches those.
 *
 * The network rule covers the tool's own process. Some frameworks load through system
 * services outside it (HTML through WebKit's network process), so the tools are also run
 * with loading turned off: `textutil -noload`, and AVFoundation without references.
 */
export function sandboxProfile(o: {
  home: string;
  work: string;
  temp: string;
  tool: string;
}): string {
  const home = sbPath(o.home);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    '(allow network-outbound (literal "/private/var/run/syslog"))',
    "(deny appleevent-send)",
    '(deny mach-lookup (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.tccd") (global-name "com.apple.tccd.system"))',
    `(deny file-read* (subpath "${home}"))`,
    `(allow file-read-metadata (literal "${home}") (literal "${home}/Library"))`,
    `(deny file-write* (require-all (require-not (subpath "${sbPath(o.work)}")) (require-not (subpath "${sbPath(o.temp)}")) (require-not (literal "/dev/null")) (require-not (literal "/dev/dtracehelper"))))`,
    "(deny process-exec*)",
    `(allow process-exec (literal "${sbPath(o.tool)}"))`,
  ].join("\n");
}

function parseJsonLine<T>(stdout: string): T | undefined {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) return undefined;
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

/**
 * Reads a file a converter wrote, by its fixed name in the work folder. The converter
 * parsed a stranger's file, so its output is not trusted: the file must be a regular file
 * (not a symlink, which `O_NOFOLLOW` refuses) with one link (not a hard link to a file
 * elsewhere). Larger files give `undefined`, or with `truncate`, their first `maxBytes`.
 */
export function readWorkFile(
  work: string,
  name: string,
  maxBytes: number,
  truncate = false,
): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(join(work, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return undefined;
    if (st.size > maxBytes && !truncate) return undefined;
    const size = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** The system tools of macOS, each run under `sandbox-exec`. */
export class MacConverterTools implements ConverterTools {
  readonly available = true;

  constructor(
    private readonly home: string,
    private readonly temp: string,
  ) {}

  private run(tool: string, args: string[], work: string): Promise<CommandResult> {
    const profile = sandboxProfile({ home: this.home, work, temp: this.temp, tool });
    return runCommand([SANDBOX_EXEC, "-p", profile, tool, ...args], TOOL_TIMEOUT_MS, {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: work,
      TMPDIR: `${this.temp}/`,
      LANG: "en_US.UTF-8",
    });
  }

  async imageSize(input: string, work: string) {
    const res = await this.run(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", input], work);
    const width = Number(/pixelWidth:\s*(\d+)/.exec(res.stdout)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(res.stdout)?.[1]);
    return res.code === 0 && width > 0 && height > 0 ? { width, height } : undefined;
  }

  async convertImage(
    input: string,
    output: string,
    work: string,
    opts: { maxPx?: number; format: "jpeg" | "png" },
  ) {
    const args = ["-s", "format", opts.format];
    if (opts.format === "jpeg") args.push("-s", "formatOptions", "80");
    if (opts.maxPx) args.push("-Z", String(opts.maxPx));
    const res = await this.run(SIPS, [...args, input, "--out", join(work, output)], work);
    return res.code === 0;
  }

  async pdf(input: string, work: string, pages: number[], maxPx: number, maxChars: number) {
    const script = join(work, "pdf.js");
    writeFileSync(script, PDF_SCRIPT, { mode: 0o600 });
    const args = ["-l", "JavaScript", script, input, work, pages.join(","), String(maxPx)];
    const res = await this.run(OSASCRIPT, [...args, String(maxChars)], work);
    return parseJsonLine<PdfInfo>(res.stdout) ?? { error: "unreadable" };
  }

  async media(input: string, work: string, frames: number, maxPx: number) {
    const script = join(work, "media.js");
    writeFileSync(script, MEDIA_SCRIPT, { mode: 0o600 });
    const args = ["-l", "JavaScript", script, input, work, String(frames), String(maxPx)];
    const res = await this.run(OSASCRIPT, args, work);
    return (
      parseJsonLine<MediaInfo>(res.stdout) ?? {
        duration_seconds: null,
        has_video: false,
        frames: [],
      }
    );
  }

  async documentText(input: string, work: string) {
    // -noload: HTML and similar formats would otherwise fetch remote images and styles.
    const args = ["-noload", "-nostore", "-convert", "txt", "-encoding", "UTF-8"];
    const res = await this.run(
      TEXTUTIL,
      [...args, "-output", join(work, "document.txt"), input],
      work,
    );
    return res.code === 0;
  }
}

/** No converters: only formats an assistant reads as they are. */
export const NO_CONVERTER_TOOLS: ConverterTools = {
  available: false,
  imageSize: async () => undefined,
  convertImage: async () => false,
  pdf: async () => ({ error: "unavailable" }),
  media: async () => ({ duration_seconds: null, has_video: false, frames: [] }),
  documentText: async () => false,
};

let darwinTemp: string | undefined;

/** The per-user temp folder (`/private/var/folders/.../T`), where macOS tools keep scratch files. */
async function userTempDir(): Promise<string> {
  if (darwinTemp) return darwinTemp;
  let dir = tmpdir();
  try {
    const res = await runCommand(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], 5_000);
    if (res.code === 0 && res.stdout.trim()) dir = res.stdout.trim();
  } catch {
    // fall back to tmpdir()
  }
  try {
    dir = realpathSync(dir);
  } catch {
    dir = realpathSync(tmpdir());
  }
  darwinTemp = dir.replace(/\/+$/, "");
  return darwinTemp;
}

/**
 * The converters for this platform. They run only sandboxed: without `sandbox-exec`, or
 * if the folders it needs cannot be found, there are none.
 */
export async function systemConverterTools(home: string): Promise<ConverterTools> {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return NO_CONVERTER_TOOLS;
  try {
    return new MacConverterTools(realpathSync(home), await userTempDir());
  } catch {
    return NO_CONVERTER_TOOLS;
  }
}

function truncateChars(text: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  return { text: chars.slice(0, max).join(""), truncated: true };
}

function decodeText(bytes: Buffer): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/\r\n/g, "\n");
}

/** Reads a text file up to about `maxChars`; undefined when it looks binary. */
function readTextFile(
  path: string,
  maxChars: number,
): { text: string; truncated: boolean } | undefined {
  const limit = Math.max(1024, maxChars * 4);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(limit);
    const n = readSync(fd, buf, 0, limit, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) return undefined;
    const cut = truncateChars(decodeText(bytes), maxChars);
    return { text: cut.text, truncated: cut.truncated || n === limit };
  } finally {
    closeSync(fd);
  }
}

/** Text a converter wrote to `name`, cut at `maxChars`. */
function readWorkText(work: string, name: string, maxChars: number) {
  const bytes = readWorkFile(work, name, Math.max(1024, maxChars * 4), true);
  if (!bytes) return undefined;
  return truncateChars(decodeText(bytes).trim(), maxChars);
}

/**
 * Turns an attachment into images and text an assistant can read:
 *
 * - images: as they are when Claude reads the format and they are small enough, otherwise
 *   converted to JPEG (HEIC, TIFF, ...) and scaled to `maxImagePx`
 * - PDFs: the text (cut at `maxTextChars`) and images of some pages
 * - videos: four frames spread over the video, and its length
 * - audio: its length
 * - text files (vCards, calendar invites, CSV, ...): the text
 * - Word, RTF, HTML and similar documents: their text
 *
 * The file is copied into a private work folder that is deleted afterwards. A converter
 * that fails or takes too long gives the details only, with a note saying so.
 */
export async function renderAttachment(
  file: AttachmentFile,
  opts: RenderOptions,
  tools: ConverterTools,
): Promise<Rendered> {
  const kind = attachmentKind({ mime: file.mime, uti: file.uti, name: file.name });
  if (kind === "text") {
    const read = readTextFile(file.path, opts.maxTextChars);
    if (!read) return unsupported(kind, "The file is not plain text.");
    return {
      kind,
      shown_as: "text",
      images: [],
      text: read.text,
      ...(read.truncated ? { text_truncated: true as const } : {}),
      details: {},
    };
  }
  if (kind === "image" && !tools.available) return passthroughImage(file);
  if (kind === "other") {
    return unsupported(
      kind,
      "This kind of file can't be shown. Its name, type and size are above.",
    );
  }
  if (!tools.available) {
    return unsupported(
      kind,
      "This server can't open this kind of file here: converting it needs macOS. Its name, type and size are above.",
    );
  }

  const temp = await userTempDir();
  const work = realpathSync(mkdtempSync(join(temp, "imsg-mcp-attachment-")));
  try {
    const ext = /^[a-z0-9]{1,10}$/.test(extensionOf(file.name)) ? extensionOf(file.name) : "bin";
    const inputName = `input.${ext}`;
    const input = join(work, inputName);
    copyFileSync(file.path, input, constants.COPYFILE_FICLONE);
    switch (kind) {
      case "image":
        return await renderImage(file, inputName, work, opts, tools);
      case "pdf":
        return await renderPdf(input, work, opts, tools);
      case "video":
      case "audio":
        return await renderMedia(kind, input, work, tools);
      case "document": {
        if (!(await tools.documentText(input, work))) {
          return unsupported(kind, "The document could not be read.");
        }
        const cut = readWorkText(work, "document.txt", opts.maxTextChars);
        if (!cut) return unsupported(kind, "The document could not be read.");
        return {
          kind,
          shown_as: "text of the document",
          images: [],
          text: cut.text,
          ...(cut.truncated ? { text_truncated: true as const } : {}),
          details: {},
        };
      }
    }
  } catch (err) {
    const slow = err instanceof Error && err.message.includes("timed out");
    return unsupported(
      kind,
      slow
        ? "Converting the file took too long, so only its details are shown."
        : "The file could not be converted, so only its details are shown.",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function unsupported(kind: AttachmentKind, note: string): Rendered {
  return { kind, shown_as: "details only", images: [], details: {}, note };
}

function passthroughImage(file: AttachmentFile): Rendered {
  const mime = PASSTHROUGH_IMAGE_MIME[extensionOf(file.name)];
  if (!mime || file.bytes > PASSTHROUGH_MAX_BYTES) {
    return unsupported(
      "image",
      "This image needs converting (it is HEIC, TIFF or very large), which needs macOS.",
    );
  }
  const fd = openSync(file.path, "r");
  try {
    const data = Buffer.alloc(file.bytes);
    const n = readSync(fd, data, 0, file.bytes, 0);
    return {
      kind: "image",
      shown_as: "image",
      images: [{ data: data.subarray(0, n), mimeType: mime, label: "the image" }],
      details: {},
    };
  } finally {
    closeSync(fd);
  }
}

async function renderImage(
  file: AttachmentFile,
  inputName: string,
  work: string,
  opts: RenderOptions,
  tools: ConverterTools,
): Promise<Rendered> {
  const ext = extensionOf(file.name);
  const size = await tools.imageSize(join(work, inputName), work);
  if (!size) return unsupported("image", "The image could not be read.");
  const longest = Math.max(size.width, size.height);
  const mime = PASSTHROUGH_IMAGE_MIME[ext];
  if (mime && longest <= opts.maxImagePx && file.bytes <= REENCODE_ABOVE_BYTES) {
    const data = readWorkFile(work, inputName, PASSTHROUGH_MAX_BYTES);
    if (!data) return unsupported("image", "The image could not be read.");
    return {
      kind: "image",
      shown_as: "image",
      images: [{ data, mimeType: mime, label: "the image" }],
      details: { width: size.width, height: size.height },
    };
  }
  // PNG and GIF can be transparent, so they stay PNG; everything else becomes JPEG.
  const format = ext === "png" || ext === "gif" ? "png" : "jpeg";
  const output = `image.${format === "png" ? "png" : "jpg"}`;
  const maxPx = longest > opts.maxImagePx ? opts.maxImagePx : undefined;
  const converted =
    (await tools.convertImage(join(work, inputName), output, work, { maxPx, format })) &&
    readWorkFile(work, output, OUTPUT_IMAGE_MAX_BYTES);
  if (!converted) return unsupported("image", "The image could not be converted.");
  const scale = maxPx ? maxPx / longest : 1;
  return {
    kind: "image",
    shown_as: maxPx ? "image, scaled down" : "image",
    images: [{ data: converted, mimeType: `image/${format}`, label: "the image" }],
    details: {
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
      original_width: size.width,
      original_height: size.height,
      ...(mime ? {} : { converted_from: ext || file.mime }),
    },
  };
}

/** Images of the pages asked for, read by their fixed names. */
function pageImages(work: string, pages: number[]): { page: number; data: Buffer }[] {
  return pages.flatMap((page) => {
    const data = readWorkFile(work, `page-${page}.jpg`, OUTPUT_IMAGE_MAX_BYTES);
    return data ? [{ page, data }] : [];
  });
}

async function renderPdf(
  input: string,
  work: string,
  opts: RenderOptions,
  tools: ConverterTools,
): Promise<Rendered> {
  const asked = [...new Set(opts.pages ?? [])]
    .filter((p) => Number.isInteger(p) && p >= 1)
    .slice(0, MAX_PDF_PAGES);
  // First pass: page count and text, plus the pages asked for (or page 1).
  let wanted = asked.length ? asked : [1];
  const info = await tools.pdf(input, work, wanted, PDF_PAGE_PX, opts.maxTextChars);
  if (info.error === "locked") {
    const count = Number.isInteger(info.pages) ? info.pages : "?";
    return unsupported("pdf", `The PDF is password-protected (${count} pages).`);
  }
  const pages = info.pages;
  if (info.error || !Number.isInteger(pages) || pages! < 1) {
    return unsupported("pdf", "The PDF could not be read.");
  }
  const pageCount = pages!;
  const text = readWorkText(work, "text.txt", opts.maxTextChars) ?? { text: "", truncated: false };
  const textLength = Number.isInteger(info.text_length) ? info.text_length! : text.text.length;
  // A scan has no text layer: show the first pages instead.
  if (!asked.length && textLength < 100 * pageCount && pageCount > 1) {
    wanted = [1, 2, 3].filter((p) => p <= pageCount);
    await tools.pdf(input, work, wanted, PDF_PAGE_PX, 0);
  }
  const images = pageImages(work, wanted);
  const shownPages = images.map((i) => i.page);
  const truncated = text.truncated || textLength > text.text.length;
  return {
    kind: "pdf",
    shown_as: textLength ? "text and page images" : "page images (no text layer)",
    images: images.map((i) => ({ data: i.data, mimeType: "image/jpeg", label: `page ${i.page}` })),
    ...(text.text ? { text: text.text } : {}),
    ...(truncated ? { text_truncated: true as const } : {}),
    details: { pages: pageCount, pages_shown: shownPages, text_characters: textLength },
    note:
      pageCount > shownPages.length
        ? `Images of page${shownPages.length === 1 ? "" : "s"} ${shownPages.join(", ")} of ${pageCount}. Pass "pages" to see others (up to ${MAX_PDF_PAGES} per call).`
        : undefined,
  };
}

async function renderMedia(
  kind: "video" | "audio",
  input: string,
  work: string,
  tools: ConverterTools,
): Promise<Rendered> {
  const count = kind === "video" ? VIDEO_FRAMES : 0;
  const res = await tools.media(input, work, count, VIDEO_FRAME_PX);
  const duration =
    typeof res.duration_seconds === "number" && Number.isFinite(res.duration_seconds)
      ? res.duration_seconds
      : null;
  const details: Record<string, unknown> = { duration_seconds: duration };
  if (kind === "audio" || !res.has_video) {
    return {
      kind,
      shown_as: "details only",
      images: [],
      details,
      note: "Audio can't be played here. If Messages transcribed a voice message, the transcript is in the message text.",
    };
  }
  const frames = (Array.isArray(res.frames) ? res.frames : []).flatMap((f) => {
    if (!Number.isInteger(f.index) || f.index < 0 || f.index >= count) return [];
    const data = readWorkFile(work, `frame-${f.index}.jpg`, OUTPUT_IMAGE_MAX_BYTES);
    const at = Number.isFinite(f.at) && f.at >= 0 ? Math.round(f.at * 10) / 10 : 0;
    return data ? [{ at, data }] : [];
  });
  if (!frames.length)
    return { ...unsupported(kind, "No frames could be read from the video."), details };
  details.frames_at_seconds = frames.map((f) => f.at);
  return {
    kind,
    shown_as: `${frames.length} still frames`,
    images: frames.map((f) => ({
      data: f.data,
      mimeType: "image/jpeg",
      label: `frame at ${f.at} s`,
    })),
    details,
    note: `Shown as ${frames.length} still frames spread through the video; the sound is not available.`,
  };
}
