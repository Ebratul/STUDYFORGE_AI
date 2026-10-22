import type { GenerateEvent, GenerateKind, GenerateRequest, RagQuestion } from "../../src/clients/rag-agent.js";

const LETTERS = ["a", "b", "c", "d", "e", "f"];

/** Deterministic stand-in for rag_agent's generation output (already "validated" the way the real service would). */
export function fakeQuestions(kind: GenerateKind, req: GenerateRequest): RagQuestion[] {
  const spec = req.spec as Record<string, unknown>;
  const count = Number(spec.count ?? 1);
  const topic = req.sources.topic ?? "the material";
  const bn = spec.language === "bn";
  const out: RagQuestion[] = [];
  const diffs: ("EASY" | "MEDIUM" | "HARD")[] = ["EASY", "MEDIUM", "HARD"];
  const doc = req.sources.document_ids[0] ?? null;
  const sourced = req.grounding !== "GENERAL";
  const evidence = sourced
    ? [{ document_id: doc, document_name: doc ? "notes.pdf" : "Pasted text", chunk_id: doc ? "chunk-1" : "paste:0", page: doc ? 1 : null, section: null, quote: `Fact number QQ about ${topic}`, quote_verified: true }]
    : [];
  for (let i = 0; i < count; i++) {
    const difficulty = spec.difficulty === "MIXED" || !spec.difficulty ? diffs[i % 3]! : (spec.difficulty as "EASY" | "MEDIUM" | "HARD");
    const n = Number(spec.option_count ?? 4);
    if (kind === "mcq") {
      out.push({
        id: `g_${(i + 1).toString(16).padStart(8, "0")}${Date.now().toString(16).slice(-4)}`,
        kind: "MCQ", language: String(spec.language ?? "en"),
        stem: `${bn ? "প্রশ্ন" : "Question"} ${i + 1} about ${topic}?`, stimulus: null,
        options: Array.from({ length: n }, (_, k) => ({ id: `${LETTERS[k]}${i}x${k}z`, text: `Option ${LETTERS[k]!.toUpperCase()} for ${i + 1}` })),
        correct_option_id: `a${i}x0z`, parts: [], answer: null,
        explanation: spec.include_explanations ? `Because option A is right for ${i + 1}.` : null,
        short_note: spec.include_short_notes ? `Remember ${topic} #${i + 1}.` : null,
        difficulty, subject: (spec.subject as string | null) ?? null, topic, tags: ["fake"],
        marks: Number(spec.marks ?? 1), negative_marks: Number(spec.negative_marks ?? 0),
        sources: evidence, source_support: sourced ? "SOURCE_QUOTED" : "MODEL_ONLY", review_reasons: [],
      });
    } else {
      const marks = (spec.part_marks as number[] | null) ?? null;
      const withAnswers = spec.mode === "WITH_ANSWERS";
      const parts = marks
        ? marks.map((m, k) => ({
            id: `p${i}x${k}z`, label: spec.language === "bn" ? ["ক", "খ", "গ", "ঘ", "ঙ", "চ"][k]! : LETTERS[k]!, level: (["KNOWLEDGE", "COMPREHENSION", "APPLICATION", "HIGHER_ORDER"][k] ?? null) as string | null,
            prompt: `Part ${k + 1} of CQ ${i + 1}`, marks: m,
            answer: withAnswers ? { text: `Answer ${k + 1}`, basis: sourced ? "SOURCE_SUPPORTED" : "GENERAL_REASONING", sources: sourced ? evidence : [] } : null,
          }))
        : [];
      out.push({
        id: `g_c${(i + 1).toString(16).padStart(7, "0")}${Date.now().toString(16).slice(-4)}`,
        kind: "CQ", language: String(spec.language ?? "en"), stem: `CQ ${i + 1} on ${topic}`, stimulus: spec.stimulus === "none" ? null : `Stimulus ${i + 1} about ${topic}`,
        options: [], correct_option_id: null, parts,
        answer: !marks && withAnswers ? { text: `Model answer ${i + 1}`, basis: sourced ? "SOURCE_SUPPORTED" : "GENERAL_REASONING", sources: sourced ? evidence : [] } : null,
        explanation: null, short_note: null, difficulty, subject: null, topic, tags: [], marks: Number(spec.total_marks ?? 10), negative_marks: 0,
        sources: evidence, source_support: sourced ? "SOURCE_QUOTED" : "MODEL_ONLY", review_reasons: [],
      });
    }
  }
  return out;
}

export async function* defaultGenerateScript(kind: GenerateKind, req: GenerateRequest): AsyncGenerator<GenerateEvent> {
  yield { event: "meta", data: { request_id: req.request_id, provider: req.chat.provider, model: req.chat.model, kind } };
  yield { event: "status", data: { stage: "generating", batch: 1, batches: 1 } };
  const questions = fakeQuestions(kind, req);
  yield {
    event: "result",
    data: { questions, rejected: 0, warnings: [], usage: { prompt_tokens: 100, completion_tokens: 50 * questions.length, llm_calls: 1 }, sources_used: [] },
  };
}
