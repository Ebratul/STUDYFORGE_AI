import PDFDocument from "pdfkit";
import type { ExportInclude } from "../types.js";
import { fontBuffer, segmentScripts, type FontKey, type Run } from "./fonts.js";
import {
  basisLabel, contextLine, formatMarks, levelLabel, metaLine, optionLabel, partLabel, sourceLine, strings, supportLabel,
  type ExportAnswer, type ExportQuestion,
} from "./model.js";

const MARGIN = { top: 56, bottom: 64, left: 56, right: 56 };
const INK = "#1f2430";
const MUTED = "#5b6270";
const ACCENT = "#5b3fd1";
const GOOD = "#1c6b3a";
const RULE = "#d9dbe3";

type Doc = InstanceType<typeof PDFDocument>;
type Style = { size?: number; bold?: boolean; color?: string; lineGap?: number };
type Layout = { x?: number; y?: number; width?: number };

const FONT_NAME: Record<Run["font"], [regular: FontKey, bold: FontKey]> = { bn: ["bn", "bnBold"], la: ["la", "laBold"], lax: ["lax", "laxBold"] };

function registerFonts(doc: Doc) {
  for (const k of ["bn", "bnBold", "la", "laBold", "lax", "laxBold"] as FontKey[]) doc.registerFont(k, fontBuffer(k));
}

/**
 * Writes text in mixed fonts: every script run is a `continued` text call, so wrapping flows across runs while each
 * Bengali run is shaped as a unit. "\n" starts a new paragraph.
 */
function write(doc: Doc, text: string, layout: Layout = {}, style: Style = {}) {
  const size = style.size ?? 10.5;
  const lineGap = style.lineGap ?? 3;
  text.split("\n").forEach((para, pi) => {
    const runs = segmentScripts(para);
    const x = layout.x ?? doc.page.margins.left;
    const width = layout.width ?? doc.page.width - doc.page.margins.right - x;
    const y = pi === 0 ? layout.y : undefined;
    if (!runs.length) {
      doc.font("la").fontSize(size).text(" ", x, y, { width, lineGap });
      return;
    }
    runs.forEach((run, i) => {
      const [reg, bold] = FONT_NAME[run.font];
      doc.font(style.bold ? bold : reg).fontSize(size).fillColor(style.color ?? INK);
      const opts = { width, lineGap, continued: i < runs.length - 1 };
      if (i === 0) doc.text(run.text, x, y, opts);
      else doc.text(run.text, opts);
    });
  });
  doc.fillColor(INK);
}

/** Starts a new page unless at least `needed` points remain. */
function room(doc: Doc, needed: number) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

/** Hanging label + body, e.g. "A)  text". */
function labelled(doc: Doc, label: string, body: string, indent: number, style: Style = {}, labelWidth = 24) {
  room(doc, 34);
  const x = doc.page.margins.left + indent;
  const y = doc.y;
  write(doc, label, { x, y, width: labelWidth }, { ...style, bold: true });
  const labelBottom = doc.y;
  write(doc, body, { x: x + labelWidth, y, width: doc.page.width - doc.page.margins.right - x - labelWidth }, style);
  if (doc.y < labelBottom) doc.y = labelBottom;
}

function answerBlock(doc: Doc, q: ExportQuestion, a: ExportAnswer, heading: string, indent: number, include: ExportInclude) {
  const t = strings(q.language);
  const x = doc.page.margins.left + indent + 74;
  labelled(doc, `${heading}:`, a.text || "—", indent, { size: 10 }, 74);
  write(doc, basisLabel(q.language, a.basis), { x }, { size: 8.5, color: MUTED });
  if (include.sources && a.sources?.length) {
    write(doc, `${t.sources}:`, { x }, { size: 8.5, color: MUTED, bold: true });
    for (const s of a.sources) write(doc, `• ${sourceLine(s)}`, { x: x + 10 }, { size: 8.5, color: MUTED, lineGap: 2 });
  }
}

function drawQuestion(doc: Doc, q: ExportQuestion, n: number, include: ExportInclude) {
  const t = strings(q.language);
  room(doc, 110);
  doc.moveDown(0.6);
  write(doc, `${n}.  ${metaLine(q)}`, {}, { size: 8.5, color: ACCENT, bold: true });
  const ctx = contextLine(q);
  if (ctx) write(doc, ctx, {}, { size: 8, color: MUTED });
  doc.moveDown(0.25);

  if (q.stimulus) {
    write(doc, t.stimulus, {}, { size: 9, bold: true, color: MUTED });
    write(doc, q.stimulus, { x: doc.page.margins.left + 12 }, { size: 10.5 });
    doc.moveDown(0.25);
  }
  write(doc, q.stem, {}, { size: 11.5, bold: q.kind === "MCQ" });
  doc.moveDown(0.3);

  if (q.kind === "MCQ") {
    q.options.forEach((o, oi) => labelled(doc, `${optionLabel(q.language, oi)})`, o.text, 12, { size: 10.5 }));
    if (include.answers && q.correctOptionId) {
      const oi = q.options.findIndex((o) => o.id === q.correctOptionId);
      doc.moveDown(0.2);
      labelled(doc, `${t.answer}:`, `${optionLabel(q.language, oi)}) ${q.options[oi]?.text ?? ""}`, 12, { size: 10, color: GOOD }, 56);
    }
  } else {
    q.parts.forEach((p, pi) => {
      const lvl = p.level ? ` (${levelLabel(q.language, p.level)})` : "";
      labelled(doc, `${partLabel(q.language, pi, p.label)})`, `${p.prompt}${lvl}  [${formatMarks(q.language, p.marks)}]`, 12, { size: 10.5 });
      if (include.answers && p.answer) answerBlock(doc, q, p.answer, t.modelAnswer, 12, include);
    });
    if (include.answers && q.answer) answerBlock(doc, q, q.answer, t.modelAnswer, 12, include);
  }

  if (include.explanations && q.explanation) labelled(doc, `${t.explanation}:`, q.explanation, 12, { size: 9.5, color: MUTED }, 70);
  if (include.notes && q.shortNote) labelled(doc, `${t.note}:`, q.shortNote, 12, { size: 9.5, color: MUTED }, 70);
  if (include.sources && q.sources?.length) {
    write(doc, `${t.sources} — ${supportLabel(q.language, q.sourceSupport)}`, { x: doc.page.margins.left + 12 }, { size: 8.5, bold: true, color: MUTED });
    for (const s of q.sources) write(doc, `• ${sourceLine(s)}`, { x: doc.page.margins.left + 22 }, { size: 8.5, color: MUTED, lineGap: 2 });
  }
  doc.moveDown(0.5);
  room(doc, 8);
  const y = doc.y;
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.y = y + 4;
}

function drawKey(doc: Doc, questions: ExportQuestion[]) {
  const entries = questions
    .map((q, i) => ({ q, n: i + 1 }))
    .filter(({ q }) => q.kind === "MCQ" && q.correctOptionId)
    .map(({ q, n }) => ({ n, label: optionLabel(q.language, q.options.findIndex((o) => o.id === q.correctOptionId)) }));
  if (!entries.length) return;
  doc.addPage();
  write(doc, strings("en").key, {}, { size: 16, bold: true, color: ACCENT });
  doc.moveDown(0.6);
  const cols = 5;
  const colW = (doc.page.width - MARGIN.left - MARGIN.right) / cols;
  let y = doc.y;
  entries.forEach((e, i) => {
    const col = i % cols;
    if (col === 0 && i > 0) y += 22;
    if (y + 22 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.y;
    }
    write(doc, `${e.n}.  ${e.label}`, { x: MARGIN.left + col * colW, y, width: colW - 8 }, { size: 11, lineGap: 0 });
  });
  doc.y = y + 22;
}

export function renderPdf(title: string, exportedAt: Date, questions: ExportQuestion[], include: ExportInclude): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: MARGIN,
      bufferPages: true,
      info: { Title: title, Creator: "StudyForge AI", Producer: "StudyForge AI", CreationDate: exportedAt },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    try {
      registerFonts(doc);
      write(doc, title, {}, { size: 20, bold: true });
      doc.moveDown(0.2);
      write(doc, `${exportedAt.toISOString().slice(0, 10)} · ${questions.length} ${strings("en").questions}`, {}, { size: 9.5, color: MUTED });
      doc.moveDown(0.3);
      const y = doc.y;
      doc.moveTo(MARGIN.left, y).lineTo(doc.page.width - MARGIN.right, y).lineWidth(1.2).strokeColor(ACCENT).stroke();
      doc.y = y + 6;

      questions.forEach((q, i) => drawQuestion(doc, q, i + 1, include));
      if (include.answers) drawKey(doc, questions);

      // Footer on every page (written inside the bottom margin without triggering a page break).
      const range = doc.bufferedPageRange();
      const footerY = doc.page.height - 38;
      const shortTitle = title.length > 70 ? `${title.slice(0, 67)}...` : title;
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font("la").fontSize(8.5).fillColor(MUTED);
        const label = `${strings("en").page} ${i - range.start + 1} ${strings("en").of} ${range.count}`;
        doc.text(label, MARGIN.left, footerY, { width: doc.page.width - MARGIN.left - MARGIN.right, align: "right", lineBreak: false });
        const runs = segmentScripts(shortTitle);
        runs.forEach((r, k) => {
          doc.font(FONT_NAME[r.font][0]).fontSize(8.5).fillColor(MUTED);
          const opts = { width: 360, lineBreak: false, continued: k < runs.length - 1 };
          if (k === 0) doc.text(r.text, MARGIN.left, footerY, opts);
          else doc.text(r.text, opts);
        });
        doc.page.margins.bottom = bottom;
      }
      doc.flushPages();
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
