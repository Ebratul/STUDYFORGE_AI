import { getEnv } from "../../config/env.js";

/** The single definition of what may be uploaded. The frontend reads this from GET /api/documents/limits. */
export const ALLOWED = {
  pdf: { mimes: ["application/pdf"], label: "PDF" },
  docx: { mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], label: "Word (.docx)" },
  txt: { mimes: ["text/plain"], label: "Plain text" },
  md: { mimes: ["text/markdown", "text/x-markdown", "text/plain"], label: "Markdown" },
} as const;
export type Ext = keyof typeof ALLOWED;

export const EXTENSION_ALIASES: Record<string, Ext> = { pdf: "pdf", docx: "docx", txt: "txt", md: "md", markdown: "md" };
export const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "wmv", "flv"]);
/** Browsers often send these for text files; they are never trusted on their own. */
export const NEUTRAL_MIMES = new Set(["", "application/octet-stream"]);

export function getLimits() {
  const env = getEnv();
  return {
    maxFileBytes: env.MAX_UPLOAD_BYTES,
    maxFilesPerUpload: env.MAX_FILES_PER_UPLOAD,
    maxRequestBytes: env.MAX_UPLOAD_BYTES * Math.min(env.MAX_FILES_PER_UPLOAD, 4) + 1024 * 1024,
    storageQuotaBytes: env.USER_STORAGE_QUOTA_BYTES,
    maxDocuments: env.MAX_DOCUMENTS_PER_USER,
    allowedExtensions: Object.keys(EXTENSION_ALIASES),
    formats: Object.entries(ALLOWED).map(([ext, v]) => ({ extension: ext, label: v.label })),
    video: {
      supported: false,
      reason: "Video uploads are not available: no transcription service is configured, and videos are never sent to a language model as raw input.",
    },
  };
}
