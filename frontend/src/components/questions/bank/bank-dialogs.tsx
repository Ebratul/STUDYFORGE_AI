"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiGet } from "@/lib/api";
import type { CollectionView, Limits, Page } from "@/lib/questions";
import { Field } from "../fields";
import { useT } from "@/lib/i18n/client";

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, pending, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; confirmLabel: string; pending?: boolean; onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)} disabled={pending}>{t("Cancel")}</Button>
          <Button variant="destructive" className="rounded-xl" onClick={onConfirm} disabled={pending}>{pending && <Loader2 className="animate-spin" aria-hidden />} {confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Create or edit a collection (question set). */
export function CollectionDialog({ open, onOpenChange, initial, limits, pending, error, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; initial?: CollectionView | null; limits: Limits; pending: boolean; error?: string | null;
  onSubmit: (v: { title: string; description: string | null; subject: string | null }) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const titleError = !title.trim() ? "Give the collection a name." : title.trim().length > limits.title ? `Use at most ${limits.title} characters.` : undefined;
  const [touched, setTouched] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!titleError) onSubmit({ title: title.trim(), description: description.trim() || null, subject: subject.trim() || null }); }} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{initial ? "Edit collection" : "New collection"}</DialogTitle>
            <DialogDescription>Collections are private to you. A question can belong to several collections without being copied.</DialogDescription>
          </DialogHeader>
          <Field label="Name" htmlFor="col-title" error={touched ? titleError : undefined}>
            <Input id="col-title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-10 rounded-xl" autoComplete="off" aria-invalid={touched && titleError ? true : undefined} />
          </Field>
          <Field label="Subject (optional)" htmlFor="col-subject"><Input id="col-subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="h-10 rounded-xl" autoComplete="off" /></Field>
          <Field label="Description (optional)" htmlFor="col-desc"><Textarea id="col-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="rounded-xl" /></Field>
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" className="rounded-xl" disabled={pending}>{pending && <Loader2 className="animate-spin" aria-hidden />} {initial ? "Save changes" : "Create collection"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PickCollectionDialog({ open, onOpenChange, count, pending, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; count: number; pending: boolean; onPick: (id: string) => void }) {
  const list = useQuery({ queryKey: ["collections", "pick"], queryFn: async () => (await apiGet<Page<CollectionView>>("/api/collections?pageSize=50")).items, enabled: open });
  const [id, setId] = useState("");
  const items = list.data ?? [];
  const chosen = id || items[0]?.id || "";
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add to a collection</DialogTitle><DialogDescription>{count} selected {count === 1 ? "question" : "questions"} will be added. Questions already in the collection are left alone.</DialogDescription></DialogHeader>
        {items.length === 0 ? <p className="text-sm text-muted-foreground">{list.isLoading ? "Loading…" : "You have no collections yet. Create one first."}</p> : (
          <div className="space-y-1.5">
            <label htmlFor="pick-collection" className="text-sm font-medium">Collection</label>
            <select id="pick-collection" value={chosen} onChange={(e) => setId(e.target.value)} className="h-10 w-full rounded-xl border bg-background px-3 text-sm">
              {items.map((c) => <option key={c.id} value={c.id}>{c.title} ({c.questionCount})</option>)}
            </select>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button className="rounded-xl" disabled={!chosen || pending} onClick={() => onPick(chosen)}>{pending && <Loader2 className="animate-spin" aria-hidden />} Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TagsDialog({ open, onOpenChange, count, pending, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; count: number; pending: boolean; onSubmit: (tags: string[]) => void }) {
  const [text, setText] = useState("");
  const tags = [...new Set(text.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); if (tags.length) onSubmit(tags); }} className="space-y-4">
          <DialogHeader><DialogTitle>Add tags</DialogTitle><DialogDescription>Tags are added to {count} selected {count === 1 ? "question" : "questions"}; existing tags are kept.</DialogDescription></DialogHeader>
          <Field label="Tags" htmlFor="bulk-tags" hint="Separate with commas."><Input id="bulk-tags" value={text} onChange={(e) => setText(e.target.value)} className="h-10 rounded-xl" autoComplete="off" /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" className="rounded-xl" disabled={!tags.length || pending}>{pending && <Loader2 className="animate-spin" aria-hidden />} Add tags</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
