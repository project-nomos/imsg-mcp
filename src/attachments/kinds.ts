/**
 * What an attachment is, from its MIME type, Apple type identifier (UTI) or file name,
 * and which file types may be sent.
 */
export type AttachmentKind = "image" | "pdf" | "video" | "audio" | "text" | "document" | "other";

const EXTENSION_KIND: Record<string, AttachmentKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  heif: "image",
  tif: "image",
  tiff: "image",
  bmp: "image",
  pdf: "pdf",
  mov: "video",
  mp4: "video",
  m4v: "video",
  "3gp": "video",
  m4a: "audio",
  mp3: "audio",
  caf: "audio",
  wav: "audio",
  aac: "audio",
  aif: "audio",
  aiff: "audio",
  amr: "audio",
  txt: "text",
  text: "text",
  md: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  vcf: "text",
  ics: "text",
  xml: "text",
  log: "text",
  doc: "document",
  docx: "document",
  rtf: "document",
  odt: "document",
  html: "document",
  htm: "document",
  webarchive: "document",
  wordml: "document",
};

const UTI_KIND: Record<string, AttachmentKind> = {
  "public.jpeg": "image",
  "public.png": "image",
  "com.compuserve.gif": "image",
  "org.webmproject.webp": "image",
  "public.heic": "image",
  "public.heif": "image",
  "public.tiff": "image",
  "com.microsoft.bmp": "image",
  "com.adobe.pdf": "pdf",
  "com.apple.quicktime-movie": "video",
  "public.mpeg-4": "video",
  "com.apple.m4v-video": "video",
  "com.apple.coreaudio-format": "audio",
  "com.apple.m4a-audio": "audio",
  "public.mp3": "audio",
  "public.plain-text": "text",
  "public.vcard": "text",
  "com.apple.ical.ics": "text",
  "public.comma-separated-values-text": "text",
  "public.json": "text",
  "com.microsoft.word.doc": "document",
  "org.openxmlformats.wordprocessingml.document": "document",
  "public.rtf": "document",
  "public.html": "document",
};

const DOCUMENT_MIME = new Set([
  "text/html",
  "text/rtf",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
]);

const TEXT_MIME = new Set([
  "application/json",
  "application/xml",
  "application/x-ndjson",
  "application/csv",
]);

/** Lowercase extension without the dot, or "" (`IMG_1.HEIC` → `heic`). */
export function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function attachmentKind(a: {
  mime?: string | null;
  uti?: string | null;
  name?: string | null;
}): AttachmentKind {
  const mime = (a.mime ?? "").toLowerCase().split(";")[0]!.trim();
  if (mime) {
    if (DOCUMENT_MIME.has(mime)) return "document";
    if (TEXT_MIME.has(mime)) return "text";
    if (mime === "application/pdf") return "pdf";
    if (mime === "image/svg+xml") return "text";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("text/")) return "text";
  }
  const uti = (a.uti ?? "").toLowerCase();
  if (uti && UTI_KIND[uti]) return UTI_KIND[uti];
  return EXTENSION_KIND[extensionOf(a.name ?? "")] ?? "other";
}

/** Image formats Claude reads as they are; others are converted to JPEG first. */
export const PASSTHROUGH_IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * File types `send_message` may send. Programs, scripts, installers, archives and the old
 * Office formats that carry macros (.doc, .xls, .ppt) are left out on purpose: a
 * manipulated assistant should not be able to send something that runs.
 */
export const SENDABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "heif",
  "tif",
  "tiff",
  "pdf",
  "mov",
  "mp4",
  "m4v",
  "m4a",
  "mp3",
  "caf",
  "wav",
  "aac",
  "txt",
  "md",
  "csv",
  "json",
  "vcf",
  "ics",
  "rtf",
  "docx",
  "xlsx",
  "pptx",
  "pages",
  "numbers",
  "key",
]);
