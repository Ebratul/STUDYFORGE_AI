"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, History, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { validateContent, viewToInput, mapQuestionFieldErrors, type FieldErrors, type Limits, type QuestionContent, type QuestionView } from "@/lib/questions";
import { AiBadge, EditedBadge, EvidenceList, NeedsReview, ReviewedBadge, SupportBadge } from "../question-badges";
import { CqEditor, McqEditor } from "../question-editor";
import { MetaChips, QuestionBody } from "../question-view";
import { ConfirmDialog } from "./bank-dialogs";

type Revision = { version: number; createdAt: string; question: QuestionContent };
const fmt = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function Provenance({ q }: { q: QuestionView }) {
  return (
    <section aria-labelledby="prov-h" className="rounded-xl border bg-muted/30 p-3 text-sm" data-testid="provenance">
      <h3 id="prov-h" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provenance</h3>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <dt className="text-muted-foreground">Origin</dt><dd>{q.origin === "AI_GENERATED" ? "AI-generated" : "Written by you"}{q.modifiedByUser && q.origin === "AI_GENERATED" ? " · edited by you since" : ""}</dd>
        {q.provenance && <><dt className="text-muted-foreground">Model</dt><dd className="font-mono text-xs">{q.provenance.provider.toLowerCase()} · {q.provenance.model}</dd>
        <dt className="text-muted-foreground">Generated</dt><dd>{fmt(q.provenance.generatedAt)}</dd></>}
        <dt className="text-muted-foreground">Version</dt><dd>{q.version}</dd>
        <dt className="text-muted-foreground">Created</dt><dd>{fmt(q.createdAt)}</dd>
        <dt className="text-muted-foreground">Last changed</dt><dd>{fmt(q.updatedAt)}</dd>
        <dt className="text-muted-foreground">In collections</dt>
        <dd>{q.collections?.length ? q.collections.map((c, i) => <span key={c.id}>{i > 0 && ", "}<Link href={`/question-bank?collection=${c.id}`} className="text-primary underline">{c.title}</Link></span>) : "None"}</dd>
      </dl>
    </section>
  );
}

function Revisions({ id, currentVersion }: { id: string; currentVersion: number }) {
  const [open, setOpen] = useState(false);
  const revs = useQuery({ queryKey: ["questions", "revisions", id, currentVersion], queryFn: async () => (await apiGet<{ items: Revision[] }>(`/api/questions/${id}/revisions`)).items, enabled: open });
  return (
    <details className="rounded-xl border px-3 py-2 text-sm" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex min-h-8 cursor-pointer items-center gap-2 font-medium"><History className="size-4 text-muted-foreground" aria-hidden /> Version history</summary>
      {open && revs.isLoading && <p className="mt-2 text-muted-foreground">Loading…</p>}
      {open && revs.isError && <p role="alert" className="mt-2 text-destructive">Couldn&apos;t load the history.</p>}
      <ol className="mt-2 space-y-2">
        {(revs.data ?? []).map((r) => (
          <li key={r.version}>
            <details className="rounded-lg border bg-card px-2.5 py-1.5">
              <summary className="cursor-pointer py-1">Version {r.version}{r.version === currentVersion ? " (current)" : ""} <span className="text-muted-foreground">· {fmt(r.createdAt)}</span></summary>
              <div className="mt-2"><QuestionBody q={r.question} /></div>
            </details>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">Edits create a new version. Exams built later will keep the version they were published with.</p>
    </details>
  );
}

/** Opens one saved question (loaded fresh from the server, so another user's id simply isn't found). */
export function QuestionDialog({ id, limits, onClose }: { id: string; limits: Limits; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["questions", "detail", id], queryFn: async () => (await apiGet<{ question: QuestionView }>(`/api/questions/${id}`)).question, retry: false });
  const [draft, setDraft] = useState<QuestionContent | null>(null);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const q = detail.data;

  const refresh = () => { void qc.invalidateQueries({ queryKey: ["questions"] }); void qc.invalidateQueries({ queryKey: ["collections"] }); };

  const save = useMutation({
    mutationFn: () => apiSend<{ question: QuestionView }>("PATCH", `/api/questions/${id}`, { question: viewToInput({ ...q!, ...draft! } as QuestionView), expectedVersion: q!.version }),
    onSuccess: ({ question }) => { qc.setQueryData(["questions", "detail", id], { ...q, ...question, collections: question.collections ?? q?.collections }); setDraft(null); setServerErrors({}); setConflict(false); refresh(); toast.success("Question saved"); },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "CONFLICT") setConflict(true);
      else if (err instanceof ApiError && err.code === "VALIDATION") setServerErrors(mapQuestionFieldErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k.startsWith("question.") ? k.replace(/^question\./, "questions.0.") : k, v]))).byIndex[0] ?? {});
      else toast.error(err instanceof ApiError ? err.message : "Couldn't save the question.");
    },
  });
  const reviewed = useMutation({
    mutationFn: () => apiSend<{ question: QuestionView }>("PATCH", `/api/questions/${id}`, { markReviewed: true }),
    onSuccess: ({ question }) => { qc.setQueryData(["questions", "detail", id], { ...q, ...question, collections: question.collections ?? q?.collections }); refresh(); toast.success("Marked as reviewed"); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't update the question."),
  });
  const remove = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/questions/${id}`),
    onSuccess: () => { refresh(); toast.success("Question deleted"); onClose(); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't delete the question."),
  });

  const errors: FieldErrors = draft ? { ...validateContent(draft, limits), ...serverErrors } : {};
  const invalid = Object.keys(errors).length > 0;
  const idPrefix = `bank-${id}`;

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{draft ? "Edit question" : "Question"}</DialogTitle>
          <DialogDescription>{draft ? "Changes create a new version. Collections and earlier versions are kept." : "Everything here belongs to you. Sources and review flags are set by the server."}</DialogDescription>
        </DialogHeader>

        {detail.isLoading && <p className="py-8 text-center text-sm text-muted-foreground" role="status">Loading…</p>}
        {detail.isError && (
          <Alert variant="destructive" role="alert"><AlertTitle>{detail.error instanceof ApiError && detail.error.status === 404 ? "Question not found" : "Couldn't load the question"}</AlertTitle>
            <AlertDescription>{detail.error instanceof ApiError && detail.error.status === 404 ? "It may have been deleted, or it isn't in your account." : "Please try again."}</AlertDescription></Alert>
        )}

        {q && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-1.5">
              {q.origin === "AI_GENERATED" && <AiBadge />}
              <SupportBadge support={q.sourceSupport} />
              {q.modifiedByUser && <EditedBadge />}
              {q.reviewedAt && <ReviewedBadge />}
            </div>

            {conflict && (
              <Alert variant="destructive" role="alert" data-testid="conflict">
                <AlertTitle>This question changed elsewhere</AlertTitle>
                <AlertDescription>
                  <p>Someone (probably you, in another tab) saved a newer version. Reload to see it — your unsaved edits here will be discarded.</p>
                  <Button size="sm" variant="outline" className="mt-2 rounded-full" onClick={() => { setDraft(null); setConflict(false); void detail.refetch(); }}>Reload latest</Button>
                </AlertDescription>
              </Alert>
            )}

            {draft ? (
              <>
                {q.kind === "MCQ" ? <McqEditor q={draft} onChange={(n) => { setDraft(n); setServerErrors({}); }} errors={errors} limits={limits} idPrefix={idPrefix} />
                  : <CqEditor q={draft} onChange={(n) => { setDraft(n); setServerErrors({}); }} errors={errors} limits={limits} idPrefix={idPrefix} withAnswers />}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" className="min-h-11 rounded-xl sm:min-h-9" onClick={() => { setDraft(null); setServerErrors({}); }} disabled={save.isPending}>Cancel</Button>
                  <Button className="min-h-11 rounded-xl sm:min-h-9" onClick={() => save.mutate()} disabled={save.isPending || invalid}>{save.isPending && <Loader2 className="animate-spin" aria-hidden />} Save changes</Button>
                </div>
              </>
            ) : (
              <>
                <QuestionBody q={q} />
                <MetaChips q={q} />
                <NeedsReview reasons={q.needsReview ? q.reviewReasons : []} />
                <EvidenceList sources={q.sources} />
                <Provenance q={q} />
                <Revisions id={q.id} currentVersion={q.version} />
                <div className="flex flex-wrap justify-end gap-2">
                  {q.needsReview && <Button variant="outline" className="min-h-11 rounded-xl sm:min-h-9" onClick={() => reviewed.mutate()} disabled={reviewed.isPending}><BadgeCheck aria-hidden /> Mark as reviewed</Button>}
                  <Button variant="outline" className="min-h-11 rounded-xl text-destructive sm:min-h-9" onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden /> Delete</Button>
                  <Button className="min-h-11 rounded-xl sm:min-h-9" onClick={() => { const { id: _i, ...content } = q; void _i; setDraft(content as QuestionContent); }}><Pencil aria-hidden /> Edit</Button>
                </div>
              </>
            )}
          </div>
        )}
        <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this question?" description="It is removed from every collection. Earlier versions are deleted with it. This can't be undone." confirmLabel="Delete question" pending={remove.isPending} onConfirm={() => remove.mutate()} />
      </DialogContent>
    </Dialog>
  );
}
