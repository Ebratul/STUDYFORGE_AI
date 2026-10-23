// Finds every translatable English string in src/ and reports bn coverage per area.
//   node scripts/i18n-extract.mjs            report (exit 1 when a "complete" area has missing Bangla keys)
//   node scripts/i18n-extract.mjs --write    also rewrites src/messages/en.json (identity map of every key)
// The English text IS the key: t("Save changes"), msg("Save changes"), rich("…{link}…", …), nt(msg("…")).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Areas and whether they are declared complete (every key must exist in bn.json — enforced by tests/unit/i18n-catalog.test.ts).
 * A string used in several areas counts for each of them. Anything outside these prefixes is intentionally English-only.
 */
export const AREAS = [
  { name: "App shell & common", complete: true, prefixes: ["src/components/app-shell/", "src/components/brand/", "src/components/common/", "src/app/layout.tsx", "src/app/error.tsx", "src/app/not-found.tsx", "src/app/global-error.tsx", "src/lib/i18n/"] },
  { name: "Auth", complete: true, prefixes: ["src/components/auth/", "src/lib/google-auth.ts", "src/app/(auth)/", "src/app/verify-email/", "src/app/(marketing)/layout.tsx"] },
  { name: "Dashboard", complete: true, prefixes: ["src/components/dashboard/", "src/app/(app)/(main)/dashboard/", "src/lib/analytics.ts"] },
  { name: "Exams & taking an exam", complete: true, prefixes: ["src/components/exams/", "src/lib/exams.ts", "src/lib/exams-api.ts", "src/app/(app)/(main)/exams/", "src/app/(app)/(main)/attempts/", "src/app/(exam)/"] },
  { name: "Results, AI feedback & study plan", complete: true, prefixes: ["src/lib/bands.ts", "src/lib/analysis.ts", "src/components/analysis/", "src/components/study-plan/"] },
  { name: "Groups, join & leaderboard", complete: true, prefixes: ["src/components/groups/", "src/components/leaderboard/", "src/lib/groups.ts", "src/lib/leaderboard.ts", "src/app/(app)/(main)/groups/", "src/app/(app)/(main)/join/"] },
  { name: "Notifications & settings", complete: true, prefixes: ["src/components/account/", "src/components/ai/", "src/lib/ai.ts", "src/lib/usage.ts", "src/app/(app)/(main)/settings/", "src/app/(app)/(main)/notifications/", "src/app/(app)/(main)/workspace/"] },
];

const CALL = /(?<![\w$.])(?:t|nt|rich|msg)\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

function unescape(s) {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|.)/g, (_m, c) => {
    if (c === "n") return "\n";
    if (c === "t") return "\t";
    if (c[0] === "u") return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ""), 16));
    return c;
  });
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

/** key -> sorted list of repo-relative files using it. Template literals with `${…}` are not keys (they cannot be translated). */
export function extractKeys(root = ROOT) {
  const keys = new Map();
  for (const file of walk(join(root, "src"))) {
    const rel = relative(root, file).split(sep).join("/");
    if (rel.startsWith("src/messages/") || rel.startsWith("src/generated/")) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CALL)) {
      if (m[1] === "`" && m[2].includes("${")) continue;
      const key = unescape(m[2]);
      if (!/[A-Za-z0-9]/.test(key) || key.length < 2) continue;
      if (!keys.has(key)) keys.set(key, new Set());
      keys.get(key).add(rel);
    }
  }
  return new Map([...keys].map(([k, v]) => [k, [...v].sort()]));
}

export const areaOf = (file) => AREAS.filter((a) => a.prefixes.some((p) => file.startsWith(p))).map((a) => a.name);

/** { area, complete, total, translated, missing[] } for each declared area. */
export function coverage(keys, bn) {
  return AREAS.map((a) => {
    const own = [...keys].filter(([, files]) => files.some((f) => a.prefixes.some((p) => f.startsWith(p)))).map(([k]) => k);
    const missing = own.filter((k) => !(typeof bn[k] === "string" && bn[k].trim() !== ""));
    return { area: a.name, complete: a.complete, total: own.length, translated: own.length - missing.length, missing };
  });
}

export function readCatalog(name, root = ROOT) {
  return JSON.parse(readFileSync(join(root, "src/messages", `${name}.json`), "utf8"));
}

/** `{name}` placeholders and plural branch names must survive translation. */
export function placeholders(s) {
  return [...s.matchAll(/\{(\w+)(?=\s*[,}])/g)].map((m) => m[1]).sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const keys = extractKeys();
  const bn = readCatalog("bn");
  if (process.argv.includes("--write")) {
    const en = Object.fromEntries([...keys.keys()].sort().map((k) => [k, k]));
    writeFileSync(join(ROOT, "src/messages/en.json"), JSON.stringify(en, null, 2) + "\n");
    console.log(`wrote src/messages/en.json (${keys.size} keys)`);
  }
  const rows = coverage(keys, bn);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad("Area", 38)}${pad("Keys", 7)}${pad("Bangla", 8)}Coverage`);
  for (const r of rows) console.log(`${pad(r.area, 38)}${pad(r.total, 7)}${pad(r.translated, 8)}${r.total ? ((r.translated / r.total) * 100).toFixed(1) : "100.0"}%${r.complete ? "" : "  (not declared complete)"}`);
  const outside = [...keys.keys()].filter((k) => !keys.get(k).some((f) => areaOf(f).length));
  console.log(`\nKeys only used outside the listed areas (English-only screens): ${outside.length}`);
  const stale = Object.keys(bn).filter((k) => !keys.has(k) && !k.startsWith("@@"));
  if (stale.length) console.log(`bn.json entries not referenced by any t()/msg() call: ${stale.length}`);
  const broken = [];
  for (const [k, v] of Object.entries(bn)) if (keys.has(k) && JSON.stringify(placeholders(k)) !== JSON.stringify(placeholders(v))) broken.push(k);
  if (broken.length) console.log(`bn.json entries whose {placeholders} differ from the English text: ${broken.length}`);
  const bad = rows.filter((r) => r.complete && r.missing.length);
  if (bad.length || broken.length) {
    for (const r of bad) console.log(`\nMissing in "${r.area}":\n  ` + r.missing.slice(0, 15).join("\n  ") + (r.missing.length > 15 ? `\n  … and ${r.missing.length - 15} more` : ""));
    process.exit(1);
  }
}
