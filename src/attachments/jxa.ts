/**
 * JavaScript for Automation helpers run by `/usr/bin/osascript -l JavaScript`. They use
 * the system frameworks through the Objective-C bridge (PDFKit, AVFoundation, AppKit), so
 * no extra software is needed. They send no Apple Events: the sandbox they run in denies
 * them. Each writes its files under fixed names in the work folder and prints one JSON
 * object; the server reads only the names it expects, never paths from this output.
 */

/**
 * `pdf.js <input> <work> <pages, e.g. "1,2"> <max px> <max chars>`
 * Writes `page-<n>.jpg` for each page asked for and `text.txt` (at most `max chars`), and
 * prints `{ pages, text_length }` or `{ error }`.
 */
export const PDF_SCRIPT = String.raw`
ObjC.import("PDFKit");
ObjC.import("AppKit");
function run(argv) {
  const [input, outDir, pagesCsv, maxPxStr, maxCharsStr] = argv;
  const maxPx = Number(maxPxStr);
  const maxChars = Number(maxCharsStr);
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(input));
  if (!doc || doc.isNil()) return JSON.stringify({ error: "unreadable" });
  const pages = Number(doc.pageCount);
  if (doc.isLocked) return JSON.stringify({ error: "locked", pages: pages });
  const str = doc.string;
  const full = str && !str.isNil() ? str.js : "";
  $(full.slice(0, maxChars)).writeToFileAtomicallyEncodingError(
    outDir + "/text.txt",
    true,
    $.NSUTF8StringEncoding,
    null,
  );
  const wanted = pagesCsv ? pagesCsv.split(",").map(Number) : [];
  for (const n of wanted) {
    if (!(n >= 1 && n <= pages)) continue;
    const page = doc.pageAtIndex(n - 1);
    const box = page.boundsForBox(0);
    const w = Number(box.size.width);
    const h = Number(box.size.height);
    const scale = Math.min(maxPx / Math.max(w, h, 1), 4);
    const image = page.thumbnailOfSizeForBox(
      $.NSMakeSize(Math.round(w * scale), Math.round(h * scale)),
      0,
    );
    const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
    const jpeg = rep.representationUsingTypeProperties(
      $.NSBitmapImageFileTypeJPEG,
      $({ NSImageCompressionFactor: 0.8 }),
    );
    jpeg.writeToFileAtomically(outDir + "/page-" + n + ".jpg", true);
  }
  return JSON.stringify({ pages: pages, text_length: full.length });
}
`;

/**
 * `media.js <input> <work> <frame count> <max px>`
 * Writes `frame-<i>.jpg`, spread evenly over a video, and prints
 * `{ duration_seconds, has_video, frames: [{ index, at }] }`. Audio gets only its length.
 * References to other files (a QuickTime reference movie) are not followed.
 */
export const MEDIA_SCRIPT = String.raw`
ObjC.import("AVFoundation");
ObjC.import("CoreMedia");
ObjC.import("AppKit");
function run(argv) {
  const [input, outDir, countStr, maxPxStr] = argv;
  const count = Number(countStr);
  const maxPx = Number(maxPxStr);
  const options = $.NSDictionary.dictionaryWithObjectForKey(
    $.NSNumber.numberWithUnsignedInteger(0xffff), // AVAssetReferenceRestrictionForbidAll
    $("AVURLAssetReferenceRestrictionsKey"),
  );
  const asset = $.NSClassFromString("AVURLAsset").URLAssetWithURLOptions(
    $.NSURL.fileURLWithPath(input),
    options,
  );
  const seconds = Number($.CMTimeGetSeconds(asset.duration));
  const duration = isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : null;
  const tracks = asset.tracks;
  let hasVideo = false;
  for (let i = 0; i < Number(tracks.count); i++) {
    if (tracks.objectAtIndex(i).mediaType.js === "vide") hasVideo = true;
  }
  const frames = [];
  if (hasVideo && count > 0) {
    const gen = $.NSClassFromString("AVAssetImageGenerator").assetImageGeneratorWithAsset(asset);
    gen.appliesPreferredTrackTransform = true;
    gen.maximumSize = $.CGSizeMake(maxPx, maxPx);
    for (let i = 0; i < count; i++) {
      const at = duration ? (duration * (i + 0.5)) / count : 0;
      const image = gen.copyCGImageAtTimeActualTimeError($.CMTimeMakeWithSeconds(at, 600), null, null);
      if (!image || (image.isNil && image.isNil())) continue;
      const rep = $.NSBitmapImageRep.alloc.initWithCGImage(image);
      const jpeg = rep.representationUsingTypeProperties(
        $.NSBitmapImageFileTypeJPEG,
        $({ NSImageCompressionFactor: 0.75 }),
      );
      if (jpeg.writeToFileAtomically(outDir + "/frame-" + i + ".jpg", true)) {
        frames.push({ index: i, at: Math.round(at * 10) / 10 });
      }
    }
  }
  return JSON.stringify({ duration_seconds: duration, has_video: hasVideo, frames: frames });
}
`;
