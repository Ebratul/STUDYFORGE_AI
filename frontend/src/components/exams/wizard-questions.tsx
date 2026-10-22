"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, FolderPlus, Info, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiGet } from "@/lib/api";
import { moveId, type ExamDraftInput, type ExamLimits, type SelectedQuestion } from "@/lib/exams";
import { DIFFICULTY_LABEL, type CollectionView, type Page, type QuestionView } from "@/lib/questions";
import { NumberInput } from "@/components/questions/fields";
import { useI18n } from "@/lib/i18n/client";

const PAGE_SIZE = 10;
type QMap = Record<string, SelectedQuestion>;

const toSelected = (q: QuestionView): SelectedQuestion => ({ id: q.id, stem: q.stem, topic: q.topic, options: q.options, correctOptionId: q.correctOptionId });

export function QuestionsStep({ draft, setDraft, qmap, setQmap, limits, errors }: {
  draft: ExamDraftInput; setDraft: (fn: (d: ExamDraftInput) => ExamDraftInput) => void; qmap: QMap; setQmap: (fn: (m: QMap) => QMap) => void; limits: ExamLimits; errors: Record<string, string>;
}) {
  const { t, format } = useI18n();
  const selected = useMemo(() => new Set(draft.questionIds), [draft.questionIds]);
  const full = draft.questionIds.length >= limits.maxQuestions;

  function add(items: QuestionView[]) {
    const fresh = items.filter((q) => q.kind === "MCQ" && !selected.has(q.id));
    const room = limits.maxQuestions - draft.questionIds.length;
    const take = fresh.slice(0, Math.max(0, room));
    if (!take.length) { if (fresh.length) toast.error(t("An exam can have up to {max} questions.", { max: limits.maxQuestions })); return 0; }
    setQmap((m) => ({ ...m, ...Object.fromEntries(take.map((q) => [q.id, toSelected(q)])) }));
    setDraft((d) => ({ ...d, questionIds: [...d.questionIds, ...take.map((q) => q.id)] }));
    if (take.length < fresh.length) toast.warning(t("Added {added}; the exam is limited to {max} questions.", { added: take.length, max: limits.maxQuestions }));
    return take.length;
  }
  const remove = (id: string) => setDraft((d) => ({ ...d, questionIds: d.questionIds.filter((x) => x !== id), marks: { ...d.marks, overrides: Object.fromEntries(Object.entries(d.marks.overrides ?? {}).filter(([k]) => k !== id)) } }));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Picker add={add} selected={selected} full={full} />
      <section aria-labelledby="sel-h" className="min-w-0 rounded-2xl border bg-card p-4 shadow-card sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 id="sel-h" className="text-base font-semibold">{t("In this exam")} <span className="font-normal text-muted-foreground" data-testid="selected-count">({format.number(draft.questionIds.length)}/{format.number(limits.maxQuestions)})</span></h3>
          {draft.questionIds.length > 0 && <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setDraft((d) => ({ ...d, questionIds: [], marks: { perQuestion: d.marks.perQuestion } }))}>{t("Clear all")}</Button>}
        </div>
        {errors.questionIds && <p role="alert" className="mt-1 text-xs font-medium text-destructive">{t(errors.questionIds)}</p>}
        {draft.questionIds.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("No questions yet. Add some from your question bank on the left.")}</p>
        ) : (
          <ol className="mt-3 space-y-2" data-testid="selected-list">
            {draft.questionIds.map((id, i) => (
              <SelectedRow key={id} id={id} index={i} count={draft.questionIds.length} q={qmap[id]} perQuestion={draft.marks.perQuestion} override={draft.marks.overrides?.[id]}
                error={errors[`marks.overrides.${id}`]}
                onLoaded={(q) => setQmap((m) => (m[id] ? m : { ...m, [id]: q }))}
                onMove={(to) => setDraft((d) => ({ ...d, questionIds: moveId(d.questionIds, i, to) }))}
                onRemove={() => remove(id)}
                onOverride={(v) => setDraft((d) => {
                  const o = { ...(d.marks.overrides ?? {}) };
                  if (v === null) delete o[id]; else o[id] = v;
                  return { ...d, marks: { ...d.marks, overrides: o } };
                })} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Picker({ add, selected, full }: { add: (items: QuestionView[]) => number; selected: Set<string>; full: boolean }) {
  const { t, format } = useI18n();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const tmr = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(tmr);
  }, [search]);

  const collections = useQuery({ queryKey: ["collections", "list"], queryFn: async () => (await apiGet<Page<CollectionView>>("/api/collections?pageSize=100")).items });
  const list = useQuery({
    queryKey: ["exam-picker", q, collectionId, page],
    queryFn: () => {
      const p = new URLSearchParams({ kind: "MCQ", page: String(page), pageSize: String(PAGE_SIZE), sort: "created" });
      if (q) p.set("q", q);
      if (collectionId) p.set("collectionId", collectionId);
      return apiGet<Page<QuestionView>>(`/api/questions?${p}`);
    },
    placeholderData: (prev) => prev,
  });
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));

  async function addCollection() {
    if (!collectionId) return;
    setBusy(true);
    try {
      let n = 0;
      for (let p = 1; p <= 10; p++) {
        const res = await apiGet<Page<QuestionView>>(`/api/collections/${collectionId}/questions?page=${p}&pageSize=100`);
        n += add(res.items);
        if (p * res.pageSize >= res.total) break;
      }
      if (n > 0) toast.success(t("Added {count, plural, one {# question} other {# questions}} from the collection", { count: n }));
      else toast.info(t("Nothing new to add from that collection (only multiple-choice questions can be used)."));
    } catch {
      toast.error(t("Couldn't load that collection."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="bank-h" className="min-w-0 rounded-2xl border bg-card p-4 shadow-card sm:p-5">
      <h3 id="bank-h" className="text-base font-semibold">{t("Your question bank")}</h3>
      <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t("Only multiple-choice questions can be used in exams. Generated MCQs must first be saved to your bank (the MCQ Generator's “Save to collection”).")}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search questions, topics, tags…")} aria-label={t("Search questions")} className="h-10 rounded-xl pl-9" />
        </div>
        <select value={collectionId} onChange={(e) => { setCollectionId(e.target.value); setPage(1); }} aria-label={t("Collection")} className="h-10 rounded-xl border bg-background px-3 text-sm">
          <option value="">{t("All questions")}</option>
          {(collections.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.title} ({format.number(c.questionCount)})</option>)}
        </select>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="rounded-lg" disabled={full || items.every((i) => selected.has(i.id))} onClick={() => add(items)}><Plus aria-hidden /> {t("Add all on this page")}</Button>
        {collectionId && <Button variant="outline" size="sm" className="rounded-lg" disabled={full || busy} onClick={() => void addCollection()}><FolderPlus aria-hidden /> {t("Add the whole collection")}</Button>}
      </div>
      {list.isLoading ? <p className="mt-4 text-sm text-muted-foreground" role="status">{t("Loading…")}</p> : items.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("No multiple-choice questions match. Generate some in the MCQ Generator or write your own in the question bank.")}</p>
      ) : (
        <ul className="mt-3 space-y-2" data-testid="picker-list">
          {items.map((qv) => {
            const on = selected.has(qv.id);
            return (
              <li key={qv.id} className="flex items-start gap-3 rounded-xl border p-3">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium">{qv.stem}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px] font-normal">{t(DIFFICULTY_LABEL[qv.difficulty])}</Badge>
                    {qv.topic && <span>{qv.topic}</span>}<span>{t("{count} options", { count: qv.options.length })}</span>
                    {qv.needsReview && <span className="text-amber-700 dark:text-amber-300">{t("needs review")}</span>}
                  </p>
                </div>
                <Button size="sm" variant={on ? "secondary" : "outline"} className="shrink-0 rounded-lg" disabled={on || full} onClick={() => add([qv])} aria-label={on ? t("Added: {stem}", { stem: qv.stem }) : t("Add: {stem}", { stem: qv.stem })}>{on ? t("Added") : t("Add")}</Button>
              </li>
            );
          })}
        </ul>
      )}
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <Button variant="outline" size="sm" className="rounded-lg" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft aria-hidden /> {t("Prev")}</Button>
          <span className="text-muted-foreground">{t("Page {page} of {pages}", { page, pages })}</span>
          <Button variant="outline" size="sm" className="rounded-lg" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t("Next")} <ChevronRight aria-hidden /></Button>
        </div>
      )}
    </section>
  );
}

function SelectedRow({ id, index, count, q, perQuestion, override, error, onLoaded, onMove, onRemove, onOverride }: {
  id: string; index: number; count: number; q: SelectedQuestion | undefined; perQuestion: number; override: number | undefined; error?: string | undefined;
  onLoaded: (q: SelectedQuestion) => void; onMove: (to: number) => void; onRemove: () => void; onOverride: (v: number | null) => void;
}) {
  const { t, format } = useI18n();
  const fetched = useQuery({ queryKey: ["exam-q", id], enabled: !q, retry: false, queryFn: async () => toSelected((await apiGet<{ question: QuestionView }>(`/api/questions/${id}`)).question) });
  useEffect(() => { if (fetched.data) onLoaded(fetched.data); }, [fetched.data, onLoaded]);
  const row = q ?? fetched.data;
  const [custom, setCustom] = useState(override !== undefined);
  return (
    <li className="rounded-xl border p-3" data-testid="selected-row">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-semibold text-accent-foreground">{format.number(index + 1)}</span>
        <p className="line-clamp-2 min-w-0 flex-1 text-sm">{row?.stem ?? (fetched.isError ? t("This question is no longer available — remove it.") : t("Loading…"))}</p>
        <div className="flex shrink-0 gap-0.5">
          <Button variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={t("Move question {n} up", { n: index + 1 })}><ArrowUp aria-hidden /></Button>
          <Button variant="ghost" size="icon-sm" disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label={t("Move question {n} down", { n: index + 1 })}><ArrowDown aria-hidden /></Button>
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={t("Remove question {n}", { n: index + 1 })}><Trash2 aria-hidden /></Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-8 text-xs text-muted-foreground">
        {custom ? (
          <>
            <label htmlFor={`m-${id}`}>{t("Marks")}</label>
            <NumberInput id={`m-${id}`} value={override ?? perQuestion} onChange={(v) => onOverride(v)} min={0.25} max={100} step={0.25} className="h-8 w-24 rounded-lg" invalid={Boolean(error)} />
            <button type="button" className="underline" onClick={() => { setCustom(false); onOverride(null); }}>{t("Use the default ({marks})", { marks: perQuestion })}</button>
          </>
        ) : (
          <>
            <span>{t("{count, plural, one {# mark} other {# marks}}", { count: perQuestion })}</span>
            <button type="button" className="underline" onClick={() => { setCustom(true); onOverride(perQuestion); }} aria-label={t("Set custom marks for question {n}", { n: index + 1 })}>{t("Change")}</button>
          </>
        )}
        {error && <span role="alert" className="font-medium text-destructive">{error}</span>}
      </div>
    </li>
  );
}
