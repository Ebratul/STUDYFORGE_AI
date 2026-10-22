"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationsPage } from "./types";

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ConversationList({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const activeId = pathname.split("/")[2];
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [title, setTitle] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);

  const list = useInfiniteQuery({
    queryKey: ["chat", "conversations", q],
    queryFn: ({ pageParam }) => apiGet<ConversationsPage>(`/api/conversations?limit=30${q ? `&q=${encodeURIComponent(q)}` : ""}${pageParam ? `&cursor=${pageParam}` : ""}`),
    initialPageParam: "" as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  const create = useMutation({
    mutationFn: () => apiSend<{ conversation: Conversation }>("POST", "/api/conversations", {}),
    onSuccess: ({ conversation }) => {
      void qc.invalidateQueries({ queryKey: ["chat", "conversations"] });
      router.push(`/chat/${conversation.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't create the conversation."),
  });

  const rename = useMutation({
    mutationFn: (c: Conversation) => apiSend("PATCH", `/api/conversations/${c.id}`, { title }),
    onSuccess: () => {
      setRenaming(null);
      void qc.invalidateQueries({ queryKey: ["chat"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? (err.fields.title ?? err.message) : "Couldn't rename."),
  });

  const remove = useMutation({
    mutationFn: (c: Conversation) => apiSend("DELETE", `/api/conversations/${c.id}`),
    onSuccess: (_r, c) => {
      setDeleting(null);
      toast.success("Conversation deleted");
      void qc.invalidateQueries({ queryKey: ["chat"] });
      if (activeId === c.id) router.push("/chat");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't delete."),
  });

  return (
    <aside className={cn("flex min-h-0 flex-col border-r bg-card", className)} aria-label="Conversations">
      <div className="space-y-2 border-b p-3">
        <Button className="w-full rounded-xl" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />} New conversation
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" className="h-9 rounded-xl pl-9" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {list.isLoading && <div className="space-y-2 p-1" role="status" aria-label="Loading conversations">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)}</div>}
        {list.isError && (
          <p role="alert" className="p-3 text-sm text-destructive">Couldn&apos;t load conversations. <button className="underline" onClick={() => void list.refetch()}>Retry</button></p>
        )}
        {!list.isLoading && !list.isError && items.length === 0 && (
          <p className="p-4 text-center text-sm text-muted-foreground">{q ? "No conversations match your search." : "No conversations yet."}</p>
        )}
        <ul className="space-y-1">
          {items.map((c) => (
            <li key={c.id} className="group relative">
              <Link
                href={`/chat/${c.id}`}
                aria-current={activeId === c.id ? "page" : undefined}
                className={cn("flex items-center gap-2.5 rounded-xl px-3 py-2.5 pr-10 text-sm transition-colors", activeId === c.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-accent/60")}
              >
                {c.mode === "DOCUMENT_ONLY" ? <FileText className="size-4 shrink-0 text-primary" aria-label="Documents only" /> : <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-label="General" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.title}</span>
                  <span className="block text-xs text-muted-foreground">{new Date(c.lastMessageAt).toLocaleDateString()}</span>
                </span>
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" className="absolute right-1 top-1/2 -translate-y-1/2 opacity-70 focus:opacity-100 group-hover:opacity-100" aria-label={`Actions for ${c.title}`}><MoreHorizontal aria-hidden /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => { setTitle(c.title); setRenaming(c); }}><Pencil aria-hidden /> Rename</DropdownMenuItem>
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting(c)}><Trash2 aria-hidden /> Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
        {list.hasNextPage && (
          <Button variant="ghost" size="sm" className="mt-2 w-full rounded-xl" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden />} Load more
          </Button>
        )}
      </div>

      <Dialog open={Boolean(renaming)} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rename conversation</DialogTitle><DialogDescription>Choose a title you&apos;ll recognise later.</DialogDescription></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (renaming && title.trim()) rename.mutate(renaming); }} className="space-y-4">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} aria-label="Conversation title" autoFocus className="h-10 rounded-xl" />
            <DialogFooter>
              <Button type="button" variant="outline" className="rounded-xl" onClick={() => setRenaming(null)}>Cancel</Button>
              <Button type="submit" className="rounded-xl" disabled={!title.trim() || rename.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete this conversation?</DialogTitle><DialogDescription><strong>{deleting?.title}</strong> and all its messages will be permanently deleted.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" className="rounded-xl" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>{remove.isPending && <Loader2 className="animate-spin" aria-hidden />} Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
