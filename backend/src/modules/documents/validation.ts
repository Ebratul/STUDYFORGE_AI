import { AppError } from "../../lib/errors.js";
import { ALLOWED, EXTENSION_ALIASES, getLimits, NEUTRAL_MIMES, VIDEO_EXTENSIONS, type Ext } from "./limits.js";

export type ValidatedUpload = { ext: Ext; mimeType: string; displayName: string };

/** Display-safe file name: no path components, no control/bidi characters, bounded length. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
  const trimmed = cleaned.length > 200 ? `${cleaned.slice(0, 190)}${cleaned.slice(cleaned.lastIndexOf("."))}`.slice(0, 200) : cleaned;
  return trimmed || "document";
}

function indexOfAscii(buf: Uint8Array, needle: string, limit = buf.length): number {
  return Buffer.from(buf.buffer, buf.byteOffset, Math.min(limit, buf.byteLength)).indexOf(needle, 0, "latin1");
}

/** True if the bytes look like UTF-8/UTF-16 text (no NULs, valid decoding). */
function looksLikeText(buf: Uint8Array): boolean {
  const head = buf.subarray(0, 64 * 1024);
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return true; // UTF-16 BOM
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length === buf.length ? head : head.subarray(0, head.length - 4)); // tolerate a split trailing code point
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a single upload by extension, declared MIME, size AND content signature.
 * The declared MIME alone is never trusted (it is attacker-controlled).
 */
export function validateUpload(filename: string, declaredMime: string, bytes: Uint8Array): ValidatedUpload {
  const limits = getLimits();
  const displayName = sanitizeFilename(filename);
  const rawExt = displayName.includes(".") ? displayName.split(".").pop()!.toLowerCase() : "";

  if (VIDEO_EXTENSIONS.has(rawExt) || declaredMime.startsWith("video/")) {
    throw new AppError("UNSUPPORTED_MEDIA", limits.video.reason);
  }
  const ext = EXTENSION_ALIASES[rawExt];
  if (!ext) throw new AppError("UNSUPPORTED_MEDIA", "Unsupported file type. Upload a PDF, DOCX, TXT or Markdown file.");
  if (bytes.byteLength === 0) throw new AppError("VALIDATION", "That file is empty.");
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new AppError("VALIDATION", `That file is too large. The limit is ${Math.floor(limits.maxFileBytes / 1024 / 1024)} MB per file.`, { maxFileBytes: limits.maxFileBytes });
  }

  const mime = declaredMime.split(";")[0]!.trim().toLowerCase();
  const allowed = ALLOWED[ext].mimes as readonly string[];
  if (!NEUTRAL_MIMES.has(mime) && !allowed.includes(mime)) {
    throw new AppError("UNSUPPORTED_MEDIA", "The file's type doesn't match its extension.");
  }

  switch (ext) {
    case "pdf":
      if (indexOfAscii(bytes, "%PDF-", 1024) < 0) throw new AppError("UNSUPPORTED_MEDIA", "That file isn't a valid PDF.");
      break;
    case "docx": {
      const zipMagic = bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
      // File names inside a ZIP are stored uncompressed in the headers, so this is a cheap structural check.
      if (!zipMagic || indexOfAscii(bytes, "word/document.xml") < 0) throw new AppError("UNSUPPORTED_MEDIA", "That file isn't a valid Word (.docx) document.");
      break;
    }
    default:
      if (!looksLikeText(bytes)) throw new AppError("UNSUPPORTED_MEDIA", "That file doesn't look like plain text.");
  }
  return { ext, mimeType: allowed[0]!, displayName };
}
