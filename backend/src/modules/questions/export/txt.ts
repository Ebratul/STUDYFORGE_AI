import type { ExportInclude } from "../types.js";
import { basisLabel, contextLine, formatMarks, levelLabel, metaLine, optionLabel, partLabel, sourceLine, strings, supportLabel, type ExportAnswer, type ExportQuestion } from "./model.js";

const WIDTH = 92;

/** Hard-wraps to WIDTH columns with a hanging indent. Words longer than the width are left intact. */
function wrap(text: string, indent: string, first = indent): string[] {
  const out: string[] = [];
  let lead = first;
  for (const para of text.split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = lead;
    let empty = true;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!empty && line.length + 1 + word.length > WIDTH) {
        out.push(line);
        line = indent + word;
      } else {
        line += (empty ? "" : " ") + word;
      }
      empty = false;
    }
    out.push(line);
    lead = indent;
  }
  return out;
}

function answerBlock(q: ExportQuestion, a: ExportAnswer, heading: string, indent: string, include: ExportInclude): string[] {
  const t = strings(q.language);
  const lines = wrap(a.text || "—", indent + "  ", `${indent}${heading}: `);
  lines.push(`${indent}  [${basisLabel(q.language, a.basis)}]`);
  if (include.sources && a.sources?.length) {
    lines.push(`${indent}  ${t.sources}:`);
    for (const s of a.sources) lines.push(...wrap(sourceLine(s), `${indent}    `, `${indent}  - `));
  }
  return lines;
}

export function renderTxt(title: string, exportedAt: Date, questions: ExportQuestion[], include: ExportInclude): string {
  const out: string[] = [];
  out.push(title, "=".repeat(Math.min(Math.max([...title].length, 8), WIDTH)));
  out.push(`${strings("en").exported} ${exportedAt.toISOString().slice(0, 10)} · ${questions.length} ${strings("en").questions}`, "");

  questions.forEach((q, i) => {
    const t = strings(q.language);
    const n = i + 1;
    out.push(`${n}. [${metaLine(q)}]`);
    const ctx = contextLine(q);
    if (ctx) out.push(...wrap(ctx, "   "));
    if (q.stimulus) {
      out.push(`   ${t.stimulus}:`, ...wrap(q.stimulus, "     "));
    }
    out.push(...wrap(q.stem, "   "));

    if (q.kind === "MCQ") {
      q.options.forEach((o, oi) => out.push(...wrap(o.text, "      ", `   ${optionLabel(q.language, oi)}) `)));
      if (include.answers && q.correctOptionId) {
        const oi = q.options.findIndex((o) => o.id === q.correctOptionId);
        out.push("", ...wrap(q.options[oi]?.text ?? "", "      ", `   ${t.answer}: ${optionLabel(q.language, oi)}) `));
      }
    }
    if (q.kind === "CQ") {
      q.parts.forEach((p, pi) => {
        const label = partLabel(q.language, pi, p.label);
        const lvl = p.level ? ` (${levelLabel(q.language, p.level)})` : "";
        out.push(...wrap(`${p.prompt}${lvl} [${formatMarks(q.language, p.marks)}]`, "      ", `   ${label}) `));
        if (include.answers && p.answer) out.push(...answerBlock(q, p.answer, t.modelAnswer, "      ", include));
      });
      if (include.answers && q.answer) out.push(...answerBlock(q, q.answer, t.modelAnswer, "   ", include));
    }

    if (include.explanations && q.explanation) out.push(...wrap(q.explanation, "      ", `   ${t.explanation}: `));
    if (include.notes && q.shortNote) out.push(...wrap(q.shortNote, "      ", `   ${t.note}: `));
    if (include.sources && q.sources?.length) {
      out.push(`   ${t.sources}: [${supportLabel(q.language, q.sourceSupport)}]`);
      for (const s of q.sources) out.push(...wrap(sourceLine(s), "        ", "     - "));
    }
    out.push("");
  });

  const mcqs = questions.map((q, i) => ({ q, n: i + 1 })).filter(({ q }) => q.kind === "MCQ" && q.correctOptionId);
  if (include.answers && mcqs.length) {
    out.push("-".repeat(40), strings("en").key, "-".repeat(40));
    const cells = mcqs.map(({ q, n }) => `${n}. ${optionLabel(q.language, q.options.findIndex((o) => o.id === q.correctOptionId))}`);
    const cellWidth = Math.max(...cells.map((c) => [...c].length)) + 3;
    const perRow = Math.max(1, Math.floor(WIDTH / cellWidth));
    for (let i = 0; i < cells.length; i += perRow) out.push(cells.slice(i, i + perRow).map((c) => c + " ".repeat(Math.max(0, cellWidth - [...c].length))).join("").trimEnd());
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
