import type { QuestionInput } from "@/lib/questions";

export type ExportInclude = { answers: boolean; explanations: boolean; notes: boolean; sources: boolean };
export type ExportFormat = "json" | "txt" | "pdf";
export type ExportSource = { questionIds: string[] } | { collectionId: string } | { runId: string } | { drafts: QuestionInput[]; runId?: string };
export type ExportRequest = { source: ExportSource; format: ExportFormat; include: ExportInclude; title?: string };

export const DEFAULT_INCLUDE: ExportInclude = { answers: true, explanations: true, notes: true, sources: false };
export const FORMAT_LABEL: Record<ExportFormat, string> = { pdf: "PDF (print-ready)", txt: "Plain text", json: "JSON (structured data)" };
