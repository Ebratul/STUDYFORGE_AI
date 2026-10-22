"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, KeyRound, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { describeGroupError, joinPath, normalizeCodeInput } from "@/lib/groups";

type Preview = { title: string; memberCount: number; capacity: number };

const asError = (err: unknown) => (err instanceof ApiError ? err : new ApiError(0, "ERROR", "Something went wrong. Please try again."));

/** Step 1: paste a code or a whole invitation link. */
export function JoinCodeForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mx-auto w-full max-w-md rounded-2xl border bg-card p-6 shadow-card">
      <span className="mb-4 inline-flex size-11 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><KeyRound className="size-5" aria-hidden /></span>
      <h1 className="text-xl font-semibold tracking-tight">Join a study group</h1>
      <p className="mt-1 text-sm text-muted-foreground">Paste the invitation code (or the whole link) you were given.</p>
      <form
        noValidate
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const code = normalizeCodeInput(value);
          if (code.length < 8) return setError("That doesn't look like a full invitation code.");
          router.push(joinPath(code));
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="join-code">Invitation code</Label>
          <Input id="join-code" value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} autoComplete="off" autoCapitalize="off" spellCheck={false} className="h-11 rounded-xl font-mono" aria-invalid={error ? true : undefined} aria-describedby={error ? "join-code-err" : undefined} />
          {error && <p id="join-code-err" role="alert" className="text-xs font-medium text-destructive">{error}</p>}
        </div>
        <Button type="submit" className="h-11 w-full rounded-xl">Continue</Button>
      </form>
    </div>
  );
}

/** Step 2: show what the invitation is for, then join. The code never leaves the request body/query of these two calls. */
export function JoinPreview({ code }: { code: string }) {
  const router = useRouter();
  const preview = useQuery({
    queryKey: ["join-preview", code],
    queryFn: async (): Promise<Preview> => {
      const r = await apiGet<{ group: { title?: string; memberCount?: number; capacity?: number } }>(`/api/groups/join-preview?code=${encodeURIComponent(code)}`);
      return { title: r.group.title ?? "Study group", memberCount: r.group.memberCount ?? 0, capacity: r.group.capacity ?? 0 };
    },
    retry: false,
    staleTime: 0,
  });
  const [joinError, setJoinError] = useState<string | null>(null);
  const join = useMutation({
    mutationFn: () => apiSend<{ group: { id: string }; alreadyMember?: boolean }>("POST", "/api/groups/join", { code }),
    onSuccess: ({ group }) => router.push(`/groups/${group.id}`),
    onError: (err) => setJoinError(describeGroupError(asError(err), "join")),
  });

  const err = preview.isError ? asError(preview.error) : null;
  const full = preview.data ? preview.data.capacity > 0 && preview.data.memberCount >= preview.data.capacity : false;

  return (
    <div className="mx-auto w-full max-w-md rounded-2xl border bg-card p-6 shadow-card" aria-live="polite">
      <span className="mb-4 inline-flex size-11 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><Users className="size-5" aria-hidden /></span>
      {preview.isLoading && <p className="text-sm text-muted-foreground" role="status"><Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />Checking the invitation…</p>}
      {err && (
        <>
          <h1 className="text-xl font-semibold tracking-tight">We can&apos;t use this invitation</h1>
          <p role="alert" data-testid="join-error" className="mt-2 flex items-start gap-2 text-sm text-muted-foreground"><AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden /> {describeGroupError(err, "join")}</p>
          <div className="mt-5 flex gap-2">
            <Button asChild className="rounded-xl"><Link href="/join">Try another code</Link></Button>
            <Button asChild variant="outline" className="rounded-xl"><Link href="/groups">My groups</Link></Button>
          </div>
        </>
      )}
      {preview.data && (
        <>
          <p className="text-sm text-muted-foreground">You&apos;ve been invited to join</p>
          <h1 className="mt-0.5 break-words text-xl font-semibold tracking-tight" data-testid="join-group-title">{preview.data.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{preview.data.memberCount} of {preview.data.capacity} members{full ? " · this group is full" : ""}</p>
          <p className="mt-3 text-xs text-muted-foreground">Joining lets members see your display name and your results on this group&apos;s exam leaderboards. You can hide your name from leaderboards in the group at any time.</p>
          {joinError && <p role="alert" className="mt-3 text-sm font-medium text-destructive">{joinError}</p>}
          <div className="mt-5 flex gap-2">
            <Button className="rounded-xl" onClick={() => { setJoinError(null); join.mutate(); }} disabled={join.isPending || full}>{join.isPending && <Loader2 className="animate-spin" aria-hidden />} Join group</Button>
            <Button asChild variant="outline" className="rounded-xl"><Link href="/groups">Not now</Link></Button>
          </div>
        </>
      )}
    </div>
  );
}
