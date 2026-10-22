import { AppError } from "../../../lib/errors.js";
import type { ExportFormat, ExportInclude, ExportItem } from "../types.js";
import { cleanTitle, exportJsonSchema, slug, toExportQuestions, type ExportJson } from "./model.js";
import { renderPdf } from "./pdf.js";
import { renderTxt } from "./txt.js";

export { exportJsonSchema, MAX_EXPORT_QUESTIONS, MAX_EXPORT_CHARS, MAX_TITLE_CHARS } from "./model.js";
export type { ExportJson, ExportQuestion } from "./model.js";

export type ExportOptions = { format: ExportFormat; include: ExportInclude; title?: string; now?: Date };
export type ExportResult = { contentType: string; extension: "json" | "txt" | "pdf"; body: Uint8Array };

const enc = new TextEncoder();

/**
 * Renders already-validated, ownership-checked questions. All formats are built from one stripped, schema-checked
 * structure (export-local ids; no database ids, owner data, provider/model, run ids or document ids).
 */
export async function renderExport(items: ExportItem[], opts: ExportOptions): Promise<ExportResult> {
  const now = opts.now ?? new Date();
  const title = cleanTitle(opts.title);
  const questions = toExportQuestions(items, opts.include);

  // Validate the structure that every format is generated from (strict: unknown properties are errors).
  const doc: ExportJson = { format: "studyforge.questions", version: 1, title, exportedAt: now.toISOString(), questions };
  const parsed = exportJsonSchema.safeParse(doc);
  if (!parsed.success) throw new AppError("VALIDATION", "Those questions could not be exported because some content is invalid.");

  switch (opts.format) {
    case "json":
      return { contentType: "application/json; charset=utf-8", extension: "json", body: enc.encode(`${JSON.stringify(parsed.data, null, 2)}\n`) };
    case "txt":
      return { contentType: "text/plain; charset=utf-8", extension: "txt", body: enc.encode(renderTxt(title, now, questions, opts.include)) };
    case "pdf":
      return { contentType: "application/pdf", extension: "pdf", body: await renderPdf(title, now, questions, opts.include) };
    default:
      throw new AppError("VALIDATION", "Choose JSON, text or PDF.");
  }
}

/** ASCII-safe download name: `<slug>-<yyyymmdd>.<ext>` (≤ 80 chars). Titles with no ASCII letters fall back to "questions". */
export function exportFilename(title: string | undefined, ext: string, now: Date = new Date()): string {
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const tail = `-${date}.${safeExt}`;
  const base = (slug(title ?? "").slice(0, 80 - tail.length).replace(/-+$/g, "") || "questions").slice(0, 80 - tail.length);
  return `${base}${tail}`;
}

/** `Content-Disposition` for a download (RFC 6266 / 5987; the name is already ASCII-safe). */
export function contentDisposition(filename: string): string {
  return `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
