"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, BookOpenCheck, ChevronLeft, ChevronRight, FolderMinus, FolderPlus, Gauge, Pencil, Printer, Search, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import {
  DIFFICULTY_LABEL, moveItem, resolveLimits, type CollectionView, type Difficulty, type Facets, type Page, type QuestionContent, type QuestionLimitsResponse, type QuestionView,
} from "@/lib/questions";
import { ExportMenu } from "../export-menu";
import { PrintableQuestions, usePrint } from "../printable";
import { CollectionDialog, ConfirmDialog, PickCollectionDialog, TagsDialog } from "./bank-dialogs";
import { CollectionSidebar } from "./collection-sidebar";
import { QuestionDialog } from "./question-dialog";
import { QuestionRow } from "./question-row";

const PAGE_SIZE = 20;
const BULK_MAX = 200;
type Sort = "created" | "updated" | "difficulty" | "order";
type Filters = { q: string; kind: "" | "MCQ" | "CQ"; difficulty: "" | Difficulty; subject: string; topic: string; tag: string; needsReview: boolean };
const NO_FILTERS: Filters = { q: "", kind: "", difficulty: "", subject: "", topic: "", tag: "", needsReview: false };

const selectCls = "h-10 w-full rounded-xl border bg-background px-3 text-sm";

function setUrl(params: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  }
  window.history.replaceState(null, "", url);
}

export function BankView({ limitsResponse, initialCollectionId, initialQuestionId }: { limitsResponse: QuestionLimitsResponse; initialCollectionId: string | null; initialQuestionId: string | null }) {
  const limits = resolveLimits(limitsResponse);
  const qc = useQueryClient();
  const [collectionId, setCollectionId] = useState<string | null>(initialCollectionId);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>(initialCollectionId ? "order" : "created");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(initialQuestionId);
  const [dialog, setDialog] = useState<null | "new-collection" | "edit-collection" | "delete-collection" | "bulk-delete" | "pick" | "tags">(null);
  const [printItems, setPrintItems] = useState<QuestionContent[]>([]);
  const { answers: printAnswers, print } = usePrint();

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => { setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() })); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const hasFilters = Object.entries(filters).some(([, v]) => v !== "" && v !== false);
  const collections = useQuery({ queryKey: ["collections", "list"], queryFn: async () => (await apiGet<Page<CollectionView>>("/api/collections?pageSize=100")).items });
  const facets = useQuery({ queryKey: ["questions", "facets"], queryFn: () => apiGet<Facets>("/api/questions/facets") });
  const collection = collections.data?.find((c) => c.id === collectionId) ?? null;
  const ordered = Boolean(collectionId) && !hasFilters && sort === "order";

  const listPath = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (ordered && collectionId) return `/api/collections/${collectionId}/questions?${p}`;
    if (collectionId) p.set("collectionId", collectionId);
    if (filters.q) p.set("q", filters.q);
    if (filters.kind) p.set("kind", filters.kind);
    if (filters.difficulty) p.set("difficulty", filters.difficulty);
    if (filters.subject) p.set("subject", filters.subject);
    if (filters.topic) p.set("topic", filters.topic);
    if (filters.tag) p.set("tag", filters.tag);
    if (filters.needsReview) p.set("needsReview", "true");
    p.set("sort", sort === "order" ? "created" : sort);
    return `/api/questions?${p}`;
  }, [page, ordered, collectionId, filters, sort]);
  const list = useQuery({ queryKey: ["questions", "list", listPath], queryFn: () => apiGet<Page<QuestionView>>(listPath), placeholderData: (prev) => prev });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["questions"] }); void qc.invalidateQueries({ queryKey: ["collections"] }); };
  const fail = (fallback: string) => (err: unknown) => toast.error(err instanceof ApiError ? err.message : fallback);
  const [dialogError, setDialogError] = useState<string | null>(null);

  function selectCollection(id: string | null) {
    setCollectionId(id);
    setSort(id ? "order" : "created");
    setPage(1);
    setSelected(new Set());
    setUrl({ collection: id });
  }
  function patchFilters(patch: Partial<Filters>) { setFilters((f) => ({ ...f, ...patch })); setPage(1); setSelected(new Set()); if (sort === "order") setSort("created"); }
  function clearFilters() { setSearch(""); setFilters(NO_FILTERS); setPage(1); if (collectionId) setSort("order"); }

  const createCollection = useMutation({
    mutationFn: (v: { title: string; description: string | null; subject: string | null }) => apiSend<{ collection: CollectionView }>("POST", "/api/collections", v),
    onSuccess: ({ collection: c }) => { toast.success(`Created “${c.title}”`); setDialog(null); setDialogError(null); invalidate(); selectCollection(c.id); },
    onError: (e) => setDialogError(e instanceof ApiError ? e.message : "Couldn't create the collection."),
  });
  const editCollection = useMutation({
    mutationFn: (v: { title: string; description: string | null; subject: string | null }) => apiSend("PATCH", `/api/collections/${collectionId}`, v),
    onSuccess: () => { toast.success("Collection updated"); setDialog(null); setDialogError(null); invalidate(); },
    onError: (e) => setDialogError(e instanceof ApiError ? e.message : "Couldn't update the collection."),
  });
  const deleteCollection = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/collections/${collectionId}`),
    onSuccess: () => { toast.success("Collection deleted. Its questions are still in your bank."); setDialog(null); invalidate(); selectCollection(null); },
    onError: fail("Couldn't delete the collection."),
  });
  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiSend<{ affected: number }>("POST", "/api/questions/bulk", { ids: [...selected], ...body }),
    onSuccess: ({ affected }, body) => {
      const n = `${affected} ${affected === 1 ? "question" : "questions"}`;
      const msg: Record<string, string> = {
        delete: `Deleted ${n}`, addToCollection: `Added ${n} to the collection`, removeFromCollection: `Removed ${n} from the collection`,
        markReviewed: `Marked ${n} as reviewed`, addTags: `Tagged ${n}`, setDifficulty: `Updated difficulty on ${n}`,
      };
      toast.success(msg[String(body.action)] ?? `Done: ${n}`);
      setDialog(null);
      if (body.action === "delete" || body.action === "removeFromCollection") setSelected(new Set());
      invalidate();
    },
    onError: fail("That action didn't work."),
  });

  async function fetchAll(): Promise<QuestionView[]> {
    const out: QuestionView[] = [];
    for (let p = 1; p <= Math.ceil(limits.collectionMaxQuestions / 50) + 1; p++) {
      const res = await apiGet<Page<QuestionView>>(`/api/collections/${collectionId}/questions?page=${p}&pageSize=50`);
      out.push(...res.items);
      if (out.length >= res.total || res.items.length === 0) break;
    }
    return out;
  }
  async function printCollection(withAnswers: boolean) {
    try {
      setPrintItems(await fetchAll());
      print(withAnswers);
    } catch (err) { fail("Couldn't load the collection for printing.")(err); }
  }
  async function moveInCollection(id: string, delta: -1 | 1) {
    try {
      const all = (await fetchAll()).map((q) => q.id);
      const from = all.indexOf(id);
      const next = moveItem(all, from, from + delta);
      if (next === all) return;
      await apiSend("PUT", `/api/collections/${collectionId}/order`, { questionIds: next });
      invalidate();
    } catch (err) { fail("Couldn't reorder.")(err); }
  }

  const ids = [...selected];
  const allOnPage = items.length > 0 && items.every((q) => selected.has(q.id));
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const noQuestionsAtAll = !list.isLoading && !hasFilters && !collectionId && total === 0 && !list.isError;
  const tooMany = ids.length > BULK_MAX;

  return (
    <div className="grid gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside><CollectionSidebar collections={collections.data ?? []} selectedId={collectionId} total={collectionId ? null : total} loading={collections.isLoading} onSelect={selectCollection} onNew={() => { setDialogError(null); setDialog("new-collection"); }} /></aside>

      <section className="min-w-0 space-y-4" aria-label="Questions">
        {collection && (
          <div className="rounded-2xl border bg-card p-4 shadow-card" data-testid="collection-header">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">{collection.title}</h2>
                <p className="text-sm text-muted-foreground">{collection.questionCount} {collection.questionCount === 1 ? "question" : "questions"}{collection.subject ? ` · ${collection.subject}` : ""}</p>
                {collection.description && <p className="mt-1 text-sm">{collection.description}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" onClick={() => { setDialogError(null); setDialog("edit-collection"); }}><Pencil aria-hidden /> Edit</Button>
                <ExportMenu label="Export collection" count={collection.questionCount} defaultTitle={collection.title} getSource={() => ({ collectionId: collection.id })} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={collection.questionCount === 0}><Printer aria-hidden /> Print</Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void printCollection(false)}>Print questions only</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void printCollection(true)}>Print with answers</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full text-destructive sm:min-h-8" onClick={() => setDialog("delete-collection")}><Trash2 aria-hidden /> Delete</Button>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-2xl border bg-card p-3 shadow-card">
          <form role="search" aria-label="Search and filter questions" onSubmit={(e) => e.preventDefault()} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="relative sm:col-span-2 xl:col-span-4">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search questions, topics, tags…" aria-label="Search questions" className="h-10 rounded-xl pl-9" />
            </div>
            <select aria-label="Type" className={selectCls} value={filters.kind} onChange={(e) => patchFilters({ kind: e.target.value as Filters["kind"] })}><option value="">All types</option><option value="MCQ">MCQ</option><option value="CQ">CQ</option></select>
            <select aria-label="Difficulty" className={selectCls} value={filters.difficulty} onChange={(e) => patchFilters({ difficulty: e.target.value as Filters["difficulty"] })}><option value="">Any difficulty</option>{(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => <option key={d} value={d}>{DIFFICULTY_LABEL[d]}</option>)}</select>
            <select aria-label="Subject" className={selectCls} value={filters.subject} onChange={(e) => patchFilters({ subject: e.target.value })}><option value="">Any subject</option>{(facets.data?.subjects ?? []).map((f) => <option key={f.value} value={f.value}>{f.value} ({f.count})</option>)}</select>
            <select aria-label="Topic" className={selectCls} value={filters.topic} onChange={(e) => patchFilters({ topic: e.target.value })}><option value="">Any topic</option>{(facets.data?.topics ?? []).map((f) => <option key={f.value} value={f.value}>{f.value} ({f.count})</option>)}</select>
            <select aria-label="Tag" className={selectCls} value={filters.tag} onChange={(e) => patchFilters({ tag: e.target.value })}><option value="">Any tag</option>{(facets.data?.tags ?? []).map((f) => <option key={f.value} value={f.value}>#{f.value} ({f.count})</option>)}</select>
            <select aria-label="Sort by" className={selectCls} value={sort} onChange={(e) => { setSort(e.target.value as Sort); setPage(1); }}>
              {collectionId && <option value="order">Collection order</option>}
              <option value="created">Newest first</option><option value="updated">Recently edited</option><option value="difficulty">Difficulty</option>
            </select>
            <div className="flex min-h-10 items-center gap-2 rounded-xl border px-3">
              <Checkbox id="f-review" checked={filters.needsReview} onCheckedChange={(v) => patchFilters({ needsReview: v === true })} />
              <label htmlFor="f-review" className="cursor-pointer text-sm">Needs review</label>
            </div>
            {hasFilters && <Button type="button" variant="ghost" className="rounded-xl" onClick={clearFilters}>Clear filters</Button>}
          </form>
        </div>

        {ids.length > 0 && (
          <div role="toolbar" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-accent/50 p-3" data-testid="bulk-bar">
            <p className="mr-1 text-sm font-medium" aria-live="polite">{ids.length} selected</p>
            <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={tooMany} onClick={() => setDialog("pick")}><FolderPlus aria-hidden /> Add to collection</Button>
            {collectionId && <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={tooMany || bulk.isPending} onClick={() => bulk.mutate({ action: "removeFromCollection", collectionId })}><FolderMinus aria-hidden /> Remove from collection</Button>}
            <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={tooMany} onClick={() => setDialog("tags")}><Tags aria-hidden /> Add tags</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={tooMany}><Gauge aria-hidden /> Set difficulty</Button></DropdownMenuTrigger>
              <DropdownMenuContent>{(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => <DropdownMenuItem key={d} onSelect={() => bulk.mutate({ action: "setDifficulty", difficulty: d })}>{DIFFICULTY_LABEL[d]}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>
            <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={tooMany || bulk.isPending} onClick={() => bulk.mutate({ action: "markReviewed" })}><BadgeCheck aria-hidden /> Mark reviewed</Button>
            <ExportMenu label="Export selected" count={ids.length} defaultTitle="Selected questions" getSource={() => ({ questionIds: ids })} disabled={tooMany} />
            <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full text-destructive sm:min-h-8" disabled={tooMany} onClick={() => setDialog("bulk-delete")}><Trash2 aria-hidden /> Delete</Button>
            <Button type="button" size="sm" variant="ghost" className="min-h-11 rounded-full sm:min-h-8" onClick={() => setSelected(new Set())}>Clear selection</Button>
            {tooMany && <p role="alert" className="w-full text-xs text-destructive">Select at most {BULK_MAX} questions for a bulk action.</p>}
          </div>
        )}

        {list.isError && (
          <Alert variant="destructive" role="alert"><AlertTitle>Couldn&apos;t load questions</AlertTitle><AlertDescription>{list.error instanceof ApiError && list.error.status === 404 ? "That collection wasn't found." : "Please try again."}
            <Button size="sm" variant="outline" className="ml-2 rounded-full" onClick={() => (collectionId && list.error instanceof ApiError && list.error.status === 404 ? selectCollection(null) : void list.refetch())}>{collectionId && list.error instanceof ApiError && list.error.status === 404 ? "Show all questions" : "Retry"}</Button></AlertDescription></Alert>
        )}
        {list.isLoading && <div className="space-y-3" aria-busy="true" aria-label="Loading questions">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>}

        {noQuestionsAtAll && (
          <EmptyState icon={BookOpenCheck} title="Your question bank is empty" description="Generate MCQs or CQs, review them, and save the ones you want to keep." action={<div className="flex gap-2"><Button asChild className="rounded-xl"><Link href="/mcq">Generate MCQs</Link></Button><Button asChild variant="outline" className="rounded-xl"><Link href="/cq">Generate CQs</Link></Button></div>} />
        )}
        {!list.isLoading && !list.isError && !noQuestionsAtAll && items.length === 0 && (
          <EmptyState icon={Search} title={collectionId && !hasFilters ? "This collection is empty" : "No questions match"} description={collectionId && !hasFilters ? "Select questions in “All questions” and add them here, or save generated questions to this collection." : "Try a different search or clear the filters."} />
        )}

        {items.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="flex min-h-8 items-center gap-2">
                <Checkbox id="select-page" checked={allOnPage ? true : items.some((q) => selected.has(q.id)) ? "indeterminate" : false} onCheckedChange={(v) => setSelected((s) => { const n = new Set(s); for (const q of items) {
                  if (v === true) n.add(q.id);
                  else n.delete(q.id);
                }
                return n; })} />
                <label htmlFor="select-page" className="cursor-pointer text-sm">Select this page</label>
              </div>
              <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="bank-total">{total} {total === 1 ? "question" : "questions"}</p>
            </div>
            <ul className="space-y-2" aria-label="Questions" aria-busy={list.isFetching || undefined}>
              {items.map((q, i) => (
                <QuestionRow key={q.id} q={q} selected={selected.has(q.id)} onSelect={toggle} onOpen={(id) => { setOpenId(id); setUrl({ question: id }); }}
                  move={ordered ? { index: (page - 1) * PAGE_SIZE + i, total, onMove: moveInCollection } : undefined} />
              ))}
            </ul>
            <nav aria-label="Pagination" className="flex items-center justify-between gap-2">
              <Button type="button" variant="outline" size="sm" className="min-h-11 rounded-full sm:min-h-8" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft aria-hidden /> Previous</Button>
              <p className="text-sm text-muted-foreground" data-testid="page-indicator">Page {page} of {pages}</p>
              <Button type="button" variant="outline" size="sm" className="min-h-11 rounded-full sm:min-h-8" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight aria-hidden /></Button>
            </nav>
          </>
        )}
      </section>

      {openId && <QuestionDialog key={openId} id={openId} limits={limits} onClose={() => { setOpenId(null); setUrl({ question: null }); }} />}
      <CollectionDialog key={`new-${dialog === "new-collection"}`} open={dialog === "new-collection"} onOpenChange={(o) => !o && setDialog(null)} limits={limits} pending={createCollection.isPending} error={dialogError} onSubmit={(v) => createCollection.mutate(v)} />
      <CollectionDialog key={`edit-${collection?.id}-${dialog === "edit-collection"}`} open={dialog === "edit-collection"} onOpenChange={(o) => !o && setDialog(null)} initial={collection} limits={limits} pending={editCollection.isPending} error={dialogError} onSubmit={(v) => editCollection.mutate(v)} />
      <ConfirmDialog open={dialog === "delete-collection"} onOpenChange={(o) => !o && setDialog(null)} title="Delete this collection?" description="The collection is removed. The questions in it stay in your question bank." confirmLabel="Delete collection" pending={deleteCollection.isPending} onConfirm={() => deleteCollection.mutate()} />
      <ConfirmDialog open={dialog === "bulk-delete"} onOpenChange={(o) => !o && setDialog(null)} title={`Delete ${ids.length} ${ids.length === 1 ? "question" : "questions"}?`} description="They're removed from your bank and every collection, along with their version history. This can't be undone." confirmLabel="Delete questions" pending={bulk.isPending} onConfirm={() => bulk.mutate({ action: "delete" })} />
      <PickCollectionDialog key={`pick-${dialog === "pick"}`} open={dialog === "pick"} onOpenChange={(o) => !o && setDialog(null)} count={ids.length} pending={bulk.isPending} onPick={(id) => bulk.mutate({ action: "addToCollection", collectionId: id })} />
      <TagsDialog key={`tags-${dialog === "tags"}`} open={dialog === "tags"} onOpenChange={(o) => !o && setDialog(null)} count={ids.length} pending={bulk.isPending} onSubmit={(tags) => bulk.mutate({ action: "addTags", tags })} />
      <PrintableQuestions items={printItems} title={collection?.title ?? "Question set"} answers={printAnswers} />
    </div>
  );
}
