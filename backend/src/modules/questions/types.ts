/** Wire/DTO types for Part 3 (see docs/PART3_SPEC.md §1 and §3). Pure types: no runtime code. */

export type QuestionKind = "MCQ" | "CQ";
export type Difficulty = "EASY" | "MEDIUM" | "HARD";
export type DifficultySetting = Difficulty | "MIXED";
export type Language = "en" | "bn";
export type Grounding = "SOURCE_ONLY" | "SOURCE_PREFERRED" | "GENERAL";
export type SourceSupport = "SOURCE_QUOTED" | "MODEL_ONLY" | "NONE";
export type Origin = "AI_GENERATED" | "USER_AUTHORED";
export type CqMode = "QUESTIONS_ONLY" | "WITH_ANSWERS";
export type CqStructure = "stimulus_4part" | "descriptive" | "multipart";
export type CqLevel = "KNOWLEDGE" | "COMPREHENSION" | "APPLICATION" | "HIGHER_ORDER";
export type AnswerBasis = "SOURCE_SUPPORTED" | "GENERAL_REASONING" | "INSUFFICIENT_EVIDENCE" | "USER_PROVIDED";
export type RunKind = "MCQ" | "CQ";
export type RunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED";

export type SourceRef = {
  documentName: string;
  /** Owner-only. Null for pasted text or after the document was deleted. Never exported. */
  documentId: string | null;
  page: number | null;
  section: string | null;
  quote: string;
  quoteVerified: boolean;
};

export type AnswerObj = { text: string; basis: AnswerBasis; sources: SourceRef[] };

export type QuestionPartContent = {
  id: string;
  label: string | null;
  level: CqLevel | null;
  prompt: string;
  marks: number;
  answer: AnswerObj | null;
};

export type QuestionContent = {
  kind: QuestionKind;
  language: Language;
  stem: string;
  stimulus: string | null;
  options: { id: string; text: string }[];
  correctOptionId: string | null;
  parts: QuestionPartContent[];
  answer: AnswerObj | null;
  explanation: string | null;
  shortNote: string | null;
  difficulty: Difficulty;
  subject: string | null;
  topic: string | null;
  tags: string[];
  marks: number;
  negativeMarks: number;
  sources: SourceRef[];
  sourceSupport: SourceSupport;
  reviewReasons: string[];
};

export type QuestionDraft = QuestionContent & { id: string };

export type QuestionView = QuestionContent & {
  id: string;
  schemaVersion: 1;
  version: number;
  origin: Origin;
  modifiedByUser: boolean;
  reviewedAt: string | null;
  needsReview: boolean;
  provenance: { provider: string; model: string; generationRunId: string | null; generatedAt: string } | null;
  collections?: { id: string; title: string }[];
  createdAt: string;
  updatedAt: string;
};

export type QuestionInput = {
  runQuestionId?: string;
  kind: QuestionKind;
  language: Language;
  stem: string;
  stimulus?: string | null;
  options?: { id?: string; text: string }[];
  correctOptionId?: string | null;
  parts?: { id?: string; label?: string | null; level?: CqLevel | null; prompt: string; marks: number; answerText?: string | null }[];
  answerText?: string | null;
  explanation?: string | null;
  shortNote?: string | null;
  difficulty: Difficulty;
  subject?: string | null;
  topic?: string | null;
  tags?: string[];
  marks?: number;
  negativeMarks?: number;
};

export type ExportInclude = { answers: boolean; explanations: boolean; notes: boolean; sources: boolean };
export type ExportFormat = "json" | "txt" | "pdf";

/** Content handed to the exporters: already validated, ownership-checked, ids not yet stripped. */
export type ExportItem = QuestionContent;

export type CollectionView = {
  id: string;
  title: string;
  description: string | null;
  subject: string | null;
  questionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RunView = {
  id: string;
  kind: RunKind;
  status: RunStatus;
  /** Echo of the validated request without secrets or the pasted text. */
  settings: Record<string, unknown>;
  provider: string;
  model: string;
  questions: QuestionDraft[];
  rejectedCount: number;
  warnings: { code: string; message: string }[];
  usage: { promptTokens: number | null; completionTokens: number | null; llmCalls: number };
  sources: { topic: string | null; pastedTextChars: number; documents: { id: string; name: string }[] };
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
};

export type RunSummary = Pick<RunView, "id" | "kind" | "status" | "provider" | "model" | "createdAt"> & { questionCount: number; topic: string | null };
