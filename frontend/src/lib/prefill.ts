import type { Grounding } from "@/lib/questions";

/** Safe prefill of the generator forms from `?topic=&subject=&grounding=` links (docs/PART5_SPEC.md §4). Never triggers generation. */
export type Prefill = { topic: string; subject: string; grounding: Grounding | null };

const GROUNDINGS: Grounding[] = ["SOURCE_ONLY", "SOURCE_PREFERRED", "GENERAL"];
const CONTROL = /[\u0000-\u001f\u007f]/g;

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
const clean = (v: string, max: number) => v.normalize("NFC").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function readPrefill(params: Record<string, string | string[] | undefined> | undefined): Prefill {
  const g = first(params?.grounding).toUpperCase();
  return {
    topic: clean(first(params?.topic), 300),
    subject: clean(first(params?.subject), 120),
    grounding: (GROUNDINGS as string[]).includes(g) ? (g as Grounding) : null,
  };
}
