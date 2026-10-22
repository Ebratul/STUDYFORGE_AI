import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as fontkit from "fontkit";

/**
 * Fonts come from the `@fontsource/*` npm packages (SIL OFL 1.1), resolved through Node's module resolution, so the
 * same code works under `tsx` (src/) and from `dist/` without a copy step.
 *
 * The packages ship per-script subsets: the Bengali subset has no Latin letters, digits or ASCII punctuation, and the Latin
 * subset has no Bengali. Text is therefore segmented by script and each run is set in the font that has its glyphs; shaping
 * (conjuncts, reph, pre-base vowel signs) is done by pdfkit's fontkit per run, so runs must only split at script boundaries.
 */
export type FontKey = "bn" | "bnBold" | "la" | "laBold" | "lax" | "laxBold";

const require_ = createRequire(import.meta.url);
const FILES: Record<FontKey, [pkg: string, file: string]> = {
  bn: ["@fontsource/noto-sans-bengali", "noto-sans-bengali-bengali-400-normal.woff"],
  bnBold: ["@fontsource/noto-sans-bengali", "noto-sans-bengali-bengali-700-normal.woff"],
  la: ["@fontsource/noto-sans", "noto-sans-latin-400-normal.woff"],
  laBold: ["@fontsource/noto-sans", "noto-sans-latin-700-normal.woff"],
  lax: ["@fontsource/noto-sans", "noto-sans-latin-ext-400-normal.woff"],
  laxBold: ["@fontsource/noto-sans", "noto-sans-latin-ext-700-normal.woff"],
};

const buffers = new Map<FontKey, Buffer>();
const coverage = new Map<FontKey, fontkit.Font>();

export function fontBuffer(key: FontKey): Buffer {
  let b = buffers.get(key);
  if (!b) {
    const [pkg, file] = FILES[key];
    b = readFileSync(join(dirname(require_.resolve(`${pkg}/package.json`)), "files", file));
    buffers.set(key, b);
  }
  return b;
}

function hasGlyph(key: FontKey, cp: number): boolean {
  let f = coverage.get(key);
  if (!f) {
    f = fontkit.create(fontBuffer(key)) as fontkit.Font;
    coverage.set(key, f);
  }
  return f.hasGlyphForCodePoint(cp);
}

export type Run = { text: string; font: "bn" | "la" | "lax" };

// U+0964/0965 (danda, double danda) live in the Devanagari block but are the Bengali full stop.
const isBengali = (cp: number) => (cp >= 0x0980 && cp <= 0x09ff) || cp === 0x0964 || cp === 0x0965 || cp === 0x200c || cp === 0x200d;
const isSpace = (ch: string) => /\s/u.test(ch);

/** Characters no font here can draw are replaced with these ASCII equivalents (or "?"). */
const SUBSTITUTE: Record<string, string> = {
  "→": "->", "≥": ">=", "≤": "<=", "✓": "+", "√": "sqrt", "−": "-",
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
  "⁰": "0", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-",
};

/**
 * Splits text into runs by font. Whitespace is neutral (it joins the surrounding run, so Bengali phrases stay one run
 * and are shaped together). Characters missing from every font are substituted rather than drawn as empty boxes.
 */
export function segmentScripts(text: string): Run[] {
  const runs: Run[] = [];
  let pendingSpace = "";
  for (const raw of text) {
    if (isSpace(raw)) {
      pendingSpace += raw === "\u00a0" ? " " : raw;
      continue;
    }
    const cp = raw.codePointAt(0)!;
    let ch = raw;
    let font: Run["font"];
    if (isBengali(cp) && hasGlyph("bn", cp)) font = "bn";
    else if (hasGlyph("la", cp)) font = "la";
    else if (hasGlyph("lax", cp)) font = "lax";
    else {
      ch = SUBSTITUTE[raw] ?? "?";
      font = "la";
    }
    const last = runs[runs.length - 1];
    if (!last) runs.push({ text: pendingSpace + ch, font });
    else if (last.font === font) last.text += pendingSpace + ch;
    else if (last.font === "bn") runs.push({ text: pendingSpace + ch, font }); // whitespace at a boundary is set in the Latin font (the Bengali subset's space is too narrow / dropped at run ends)
    else {
      last.text += pendingSpace;
      runs.push({ text: ch, font });
    }
    pendingSpace = "";
  }
  if (pendingSpace) {
    const last = runs[runs.length - 1];
    if (last) last.text += pendingSpace;
    else runs.push({ text: pendingSpace, font: "la" });
  }
  return runs;
}
