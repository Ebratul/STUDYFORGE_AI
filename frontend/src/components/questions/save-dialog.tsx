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
import { Field, Segmented } from "./fields";

export type SaveTarget = { kind: "none" } | { kind: "existing"; id: string } | { kind: "new"; title: string; description?: string };
type Mode = "collection" | "set";

/**
 * Where to put the selected questions. A "collection" (also called a question set) is how questions are grouped for reuse;
 * timed exams that use these sets arrive in a later part of the build.
 */
export function SaveDialog({
  open, onOpenChange, mode, count, pending, error, defaultTitle, limits, onSubmit,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; mode: Mode; count: number; pending: boolean; error?: string | null; defaultTitle: string; limits: Limits;
  onSubmit: (t: SaveTarget) => void;
}) {
  const collections = useQuery({
    queryKey: ["collections", "pick"],
    queryFn: async () => (await apiGet<Page<CollectionView>>("/api/collections?pageSize=50")).items,
    enabled: open && mode === "collection",
    staleTime: 5_000,
  });
  const [choice, setChoice] = useState<"existing" | "new" | "none" | null>(null);
  const [existingId, setExistingId] = useState("");
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState("");
  const list = collections.data ?? [];
  const effective = mode === "set" ? "new" : (choice ?? (list.length ? "existing" : "new"));
  const chosenId = existingId || list[0]?.id || "";
  const titleError = effective === "new" && !title.trim() ? "Give the set a name." : effective === "new" && title.trim().length > limits.title ? `Use at most ${limits.title} characters.` : undefined;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (titleError) return;
    if (effective === "none") onSubmit({ kind: "none" });
    else if (effective === "existing") {
      if (chosenId) onSubmit({ kind: "existing", id: chosenId });
    }
    else onSubmit({ kind: "new", title: title.trim(), description: description.trim() || undefined });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{mode === "set" ? "Save as a question set" : "Save to your question bank"}</DialogTitle>
            <DialogDescription>
              {count} {count === 1 ? "question" : "questions"} will be checked by the server and saved. Collections (question sets) group questions for reuse — timed exams that use them arrive in a later part of the build.
            </DialogDescription>
          </DialogHeader>

          {mode === "collection" && (
            <Segmented
              legend="Add to"
              name="save-target"
              value={effective}
              onChange={setChoice}
              options={[
                { value: "existing", label: "Existing collection", disabled: list.length === 0, disabledReason: "You have no collections yet." },
                { value: "new", label: "New collection" },
                { value: "none", label: "Just save" },
              ]}
            />
          )}

          {effective === "existing" && (
            <div className="space-y-1.5">
              <label htmlFor="save-existing" className="text-sm font-medium">Collection</label>
              <select id="save-existing" value={chosenId} onChange={(e) => setExistingId(e.target.value)} className="h-10 w-full rounded-xl border bg-background px-3 text-sm">
                {list.map((c) => <option key={c.id} value={c.id}>{c.title} ({c.questionCount})</option>)}
              </select>
            </div>
          )}
          {effective === "new" && (
            <div className="space-y-3">
              <Field label="Name" htmlFor="save-title" error={titleError}>
                <Input id="save-title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-10 rounded-xl" maxLength={limits.title + 20} autoComplete="off" aria-invalid={titleError ? true : undefined} />
              </Field>
              <Field label="Description (optional)" htmlFor="save-desc">
                <Textarea id="save-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={limits.description + 20} className="rounded-xl" />
              </Field>
            </div>
          )}
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" className="rounded-xl" disabled={pending || Boolean(titleError) || (effective === "existing" && !chosenId)}>
              {pending && <Loader2 className="animate-spin" aria-hidden />} Save {count} {count === 1 ? "question" : "questions"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
