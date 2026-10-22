"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, ClipboardCopy, FolderPlus, Info, Printer, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ApiError, apiSend } from "@/lib/api";
import { describeGenerationError, toGenerationError } from "@/lib/questions-api";
import type { ExportSource } from "@/lib/questions-export";
import {
  draftToInput, editableSnapshot, mapQuestionFieldErrors, moveItem, questionsToText, toInput, validateContent, WARNING_TEXT,
  type CollectionView, type Limits, type QuestionContent, type QuestionDraft, type QuestionView, type RunView,
} from "@/lib/questions";
import { ExportMenu } from "./export-menu";
import { PrintableQuestions, usePrint } from "./printable";
import { ReviewCard, type CardHandlers, type ReviewItem } from "./review-card";
import { SaveDialog, type SaveTarget } from "./save-dialog";

type SaveResponse = { items: { index: number; status: "CREATED" | "EXISTING"; question: QuestionView }[]; collection: CollectionView | null; warnings: { index: number; code: string; message: string }[] };

let seq = 0;
const toItem = (d: QuestionDraft): ReviewItem => ({
  key: `k${++seq}`, draftId: d.id, current: stripId(d), base: editableSnapshot(d), selected: true, editing: false, regenerating: false, saved: null, serverErrors: {},
});
const stripId = (d: QuestionDraft): QuestionContent => {
  const { id: _id, ...rest } = d;
  void _id;
  return rest;
};

/**
 * Editable review of one generation run. Everything the user does here (edit, reorder, select, delete, regenerate) is local until they save;
 * saving sends only content, and the server re-validates it and derives sources/provenance itself.
 */
export function ReviewWorkspace({ run, limits, withAnswers, onRegenerateAll, generating, title }: {
  run: RunView; limits: Limits; withAnswers: boolean; onRegenerateAll: () => void; generating: boolean; title: string;
}) {
  const qc = useQueryClient();
  const [items, setItems] = useState<ReviewItem[]>(() => run.questions.map(toItem));
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; });
  const [saveMode, setSaveMode] = useState<"collection" | "set" | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [lastSave, setLastSave] = useState<{ count: number; collection: CollectionView | null } | null>(null);
  const [generalErrors, setGeneralErrors] = useState<string[]>([]);
  const { answers: printAnswers, print } = usePrint();

  const patch = useCallback((key: string, fn: (i: ReviewItem) => ReviewItem) => setItems((cur) => cur.map((i) => (i.key === key ? fn(i) : i))), []);

  const handlers: CardHandlers = useMemo(
    () => ({
      onSelect: (key, on) => patch(key, (i) => ({ ...i, selected: on })),
      onToggleEdit: (key) => patch(key, (i) => ({ ...i, editing: !i.editing })),
      onChange: (key, next) => patch(key, (i) => ({ ...i, current: next, serverErrors: {} })),
      onMove: (key, delta) => setItems((cur) => {
        const from = cur.findIndex((i) => i.key === key);
        return moveItem(cur, from, from + delta);
      }),
      onRegenerate: async (key) => {
        const cur = itemsRef.current;
        const target = cur.find((i) => i.key === key);
        if (!target) return;
        const avoid = cur.map((i) => i.current.stem.slice(0, 300)).filter(Boolean).slice(0, 60);
        patch(key, (i) => ({ ...i, regenerating: true }));
        try {
          const { question } = await apiSend<{ question: QuestionDraft }>("POST", `/api/generation/runs/${run.id}/regenerate`, { questionId: target.draftId, avoid });
          patch(key, (i) => ({ ...i, draftId: question.id, current: stripId(question), base: editableSnapshot(question), saved: null, serverErrors: {}, regenerating: false, editing: false }));
          toast.success("Question regenerated");
        } catch (err) {
          patch(key, (i) => ({ ...i, regenerating: false }));
          const d = describeGenerationError(err instanceof ApiError ? toGenerationError(err) : { code: "NETWORK", message: "Couldn't reach the server.", retryable: true, retryAfter: null, details: {}, fields: {} });
          toast.error(`${d.title}. ${d.message}`);
        }
      },
      onDelete: (key) => {
        const cur = itemsRef.current;
        const index = cur.findIndex((i) => i.key === key);
        const removed = cur[index];
        if (!removed) return;
        setItems((c) => c.filter((i) => i.key !== key));
        toast(removed.saved ? "Removed from this list (it stays in your question bank)" : "Question removed", {
          action: { label: "Undo", onClick: () => setItems((c) => { const next = c.slice(); next.splice(Math.min(index, next.length), 0, removed); return next; }) },
        });
      },
    }),
    [patch, run.id],
  );

  const snapshotOf = (i: ReviewItem) => editableSnapshot(i.current);
  const selected = items.filter((i) => i.selected);
  const allSelected = items.length > 0 && selected.length === items.length;
  const needsReview = items.filter((i) => i.current.reviewReasons.length > 0).length;
  const unsaved = items.some((i) => !i.saved || snapshotOf(i) !== i.saved.snapshot);
  const anyEdited = items.some((i) => snapshotOf(i) !== i.base) || items.some((i) => i.saved);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  function exportSource(): ExportSource {
    if (selected.every((i) => i.saved && snapshotOf(i) === i.saved.snapshot)) return { questionIds: selected.map((i) => i.saved!.id) };
    return { drafts: selected.map((i) => draftToInput({ ...i.current, id: i.draftId })), runId: run.id };
  }

  async function copy(withAnswersToo: boolean) {
    try {
      await navigator.clipboard.writeText(questionsToText(selected.map((i) => i.current), { answers: withAnswersToo, explanations: withAnswersToo, notes: withAnswersToo }));
      toast.success(`Copied ${selected.length} ${selected.length === 1 ? "question" : "questions"}`);
    } catch {
      toast.error("Couldn't copy. Your browser blocked clipboard access.");
    }
  }

  async function save(target: SaveTarget) {
    setSaveError(null);
    setGeneralErrors([]);
    const chosen = itemsRef.current.filter((i) => i.selected);
    const bad = chosen.find((i) => Object.keys(validateContent(i.current, limits)).length > 0);
    if (bad) {
      patch(bad.key, (i) => ({ ...i, editing: true }));
      setSaveError("Fix the highlighted questions before saving.");
      document.getElementById(`q-${bad.key}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (chosen.length > limits.saveBatchMax) { setSaveError(`Save at most ${limits.saveBatchMax} questions at a time.`); return; }
    setSaving(true);
    try {
      const fresh = chosen.filter((i) => !i.saved);
      const resaved = chosen.filter((i) => i.saved);
      let collection: CollectionView | null = null;
      let collectionRef: { id: string } | { create: { title: string; description?: string } } | undefined =
        target.kind === "existing" ? { id: target.id } : target.kind === "new" ? { create: { title: target.title, description: target.description } } : undefined;

      if (fresh.length) {
        const res = await apiSend<SaveResponse>("POST", "/api/questions", {
          runId: run.id, questions: fresh.map((i) => draftToInput({ ...i.current, id: i.draftId })), ...(collectionRef ? { collection: collectionRef } : {}),
        }).catch((err) => { throw Object.assign(err as Error, { fresh }); });
        collection = res.collection;
        if (collection) collectionRef = { id: collection.id };
        const byIndex = new Map(res.items.map((r) => [r.index, r.question]));
        setItems((cur) => cur.map((i) => {
          const at = fresh.findIndex((f) => f.key === i.key);
          const q = at >= 0 ? byIndex.get(at) : undefined;
          return q ? { ...i, saved: { id: q.id, version: q.version, snapshot: snapshotOf(i) }, serverErrors: {} } : i;
        }));
        for (const w of res.warnings) {
          const at = itemsRef.current.findIndex((x) => x.key === fresh[w.index]?.key);
          toast.warning(`Question ${(at >= 0 ? at : w.index) + 1}: ${w.message}`);
        }
      }
      for (const i of resaved) {
        if (snapshotOf(i) === i.saved!.snapshot) continue;
        const { question } = await apiSend<{ question: QuestionView }>("PATCH", `/api/questions/${i.saved!.id}`, { question: toInput(i.current), expectedVersion: i.saved!.version });
        patch(i.key, (x) => ({ ...x, saved: { id: question.id, version: question.version, snapshot: snapshotOf(x) } }));
      }
      if (resaved.length && collectionRef) {
        if ("create" in collectionRef) {
          const created = await apiSend<{ collection: CollectionView }>("POST", "/api/collections", collectionRef.create);
          collection = created.collection;
          collectionRef = { id: created.collection.id };
        }
        await apiSend("POST", `/api/collections/${(collectionRef as { id: string }).id}/questions`, { questionIds: resaved.map((i) => i.saved!.id) });
      }
      setLastSave({ count: chosen.length, collection });
      setSaveMode(null);
      toast.success(`Saved ${chosen.length} ${chosen.length === 1 ? "question" : "questions"}${collection ? ` to “${collection.title}”` : ""}`);
      void qc.invalidateQueries({ queryKey: ["questions"] });
      void qc.invalidateQueries({ queryKey: ["collections"] });
    } catch (err) {
      const fresh = (err as { fresh?: ReviewItem[] }).fresh;
      if (err instanceof ApiError && err.code === "VALIDATION" && fresh) {
        const { byIndex, general } = mapQuestionFieldErrors(err.fields);
        setItems((cur) => cur.map((i) => {
          const at = fresh.findIndex((f) => f.key === i.key);
          return at >= 0 && byIndex[at] ? { ...i, serverErrors: byIndex[at], editing: true } : i;
        }));
        setGeneralErrors(Object.entries(general).map(([k, v]) => `${k}: ${v}`));
        setSaveError(err.message || "The server rejected some questions. They're highlighted below.");
        setSaveMode(null);
      } else {
        setSaveError(err instanceof ApiError ? err.message : "Couldn't save. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  const exportCount = selected.length;
  const contents = selected.map((i) => i.current);

  return (
    <section aria-labelledby="review-heading" className="space-y-4" data-testid="review-workspace">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="review-heading" className="text-lg font-semibold">Review your {run.kind === "MCQ" ? "questions" : "CQs"}</h2>
          <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="review-summary">
            {items.length} {items.length === 1 ? "question" : "questions"} · {selected.length} selected{needsReview ? ` · ${needsReview} need review` : ""}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">Generated with <span className="font-mono">{run.provider.toLowerCase()} · {run.model}</span>{run.usage.llmCalls ? ` · ${run.usage.llmCalls} AI ${run.usage.llmCalls === 1 ? "call" : "calls"}` : ""}</p>
      </div>

      <Alert className="border-primary/30 bg-info-soft">
        <ShieldAlert className="text-primary" aria-hidden />
        <AlertTitle>AI-generated — review before use</AlertTitle>
        <AlertDescription>Checks can catch formatting problems and missing evidence, but they can&apos;t guarantee an answer key is right. Read each question, and use Edit to fix anything.</AlertDescription>
      </Alert>

      {(run.warnings.length > 0 || run.rejectedCount > 0) && (
        <Alert role="status">
          <Info aria-hidden />
          <AlertTitle>About this run</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-5">
              {run.rejectedCount > 0 && <li>{run.rejectedCount} generated {run.rejectedCount === 1 ? "question was" : "questions were"} rejected by validation and not shown.</li>}
              {run.warnings.map((w) => <li key={w.code}>{WARNING_TEXT[w.code] ?? w.message}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card p-3 shadow-card" role="toolbar" aria-label="Question set actions">
        <div className="flex min-h-11 items-center gap-2 pr-2 sm:min-h-8">
          <Checkbox id="select-all" checked={allSelected ? true : selected.length ? "indeterminate" : false} onCheckedChange={(v) => setItems((c) => c.map((i) => ({ ...i, selected: v === true })))} />
          <label htmlFor="select-all" className="cursor-pointer text-sm font-medium">Select all</label>
        </div>
        <Button type="button" size="sm" className="min-h-11 rounded-full sm:min-h-8" disabled={selected.length === 0} onClick={() => { setSaveError(null); setSaveMode("collection"); }}><BookmarkPlus aria-hidden /> Save to collection</Button>
        <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={selected.length === 0} onClick={() => { setSaveError(null); setSaveMode("set"); }}><FolderPlus aria-hidden /> Save as question set</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={selected.length === 0}><ClipboardCopy aria-hidden /> Copy</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => void copy(false)}>Copy questions only</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copy(true)}>Copy with answers and notes</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ExportMenu count={exportCount} defaultTitle={title} getSource={exportSource} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={selected.length === 0}><Printer aria-hidden /> Print</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => print(false)}>Print questions only</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => print(true)}>Print with answers</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" size="sm" variant="ghost" className="min-h-11 rounded-full sm:ml-auto sm:min-h-8" disabled={generating} onClick={() => (anyEdited ? setConfirmAll(true) : onRegenerateAll())}><RotateCcw aria-hidden /> Regenerate all</Button>
      </div>

      {saveError && !saveMode && <p role="alert" className="text-sm font-medium text-destructive" data-testid="save-error">{saveError}</p>}
      {generalErrors.length > 0 && <ul role="alert" className="list-disc pl-5 text-sm text-destructive">{generalErrors.map((g) => <li key={g}>{g}</li>)}</ul>}
      {lastSave && (
        <Alert role="status" className="border-success/40 bg-success-soft" data-testid="save-success">
          <AlertTitle>Saved {lastSave.count} {lastSave.count === 1 ? "question" : "questions"}</AlertTitle>
          <AlertDescription>
            {lastSave.collection ? <>Added to “{lastSave.collection.title}”. </> : null}
            <Link href={lastSave.collection ? `/question-bank?collection=${lastSave.collection.id}` : "/question-bank"} className="font-medium text-primary underline">Open your question bank</Link>
          </AlertDescription>
        </Alert>
      )}

      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">You removed every question. Generate again or reopen a recent generation.</p>
      ) : (
        <ol className="space-y-4" aria-label="Generated questions">
          {items.map((item, index) => (
            <ReviewCard key={item.key} item={item} index={index} total={items.length} edited={snapshotOf(item) !== item.base} dirtySinceSave={Boolean(item.saved && snapshotOf(item) !== item.saved.snapshot)} limits={limits} withAnswers={withAnswers} busy={generating} handlers={handlers} />
          ))}
        </ol>
      )}

      <SaveDialog key={saveMode ?? "closed"} open={saveMode !== null} onOpenChange={(o) => !o && setSaveMode(null)} mode={saveMode ?? "collection"} count={selected.length} pending={saving} error={saveMode ? saveError : null} defaultTitle={title} limits={limits} onSubmit={(t) => void save(t)} />

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace this whole set?</DialogTitle>
            <DialogDescription>You&apos;ve edited or saved some of these questions. Regenerating writes a brand-new set from your settings and replaces what you see here. Saved questions stay in your question bank.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={() => setConfirmAll(false)}>Keep this set</Button>
            <Button className="rounded-xl" onClick={() => { setConfirmAll(false); onRegenerateAll(); }}>Regenerate all</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PrintableQuestions items={contents} title={title} answers={printAnswers} />
    </section>
  );
}
