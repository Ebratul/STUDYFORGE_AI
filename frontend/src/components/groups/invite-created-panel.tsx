"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatCode, inviteUsage, type CreatedInvite } from "@/lib/groups";

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
    return true;
  } catch {
    toast.error("Couldn't copy automatically. Select the text and copy it manually.");
    return false;
  }
}

/** Shown once, right after creation. The code is never retrievable again (only its hash is stored). */
export function InviteCreatedPanel({ created, onDismiss }: { created: CreatedInvite; onDismiss: () => void }) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const run = async (kind: "code" | "link") => {
    if (await copy(kind === "code" ? created.code : created.link, kind === "code" ? "Code" : "Link")) setCopied(kind);
  };
  return (
    <section className="rounded-2xl border-2 border-primary/40 bg-accent/40 p-5" aria-labelledby="inv-new-h" data-testid="invite-created">
      <h2 id="inv-new-h" className="flex items-center gap-2 text-base font-semibold"><KeyRound className="size-4" aria-hidden /> Your new invitation</h2>
      <p role="note" className="mt-1 text-sm font-medium">This is the only time you&apos;ll see this code. We store only a scrambled version, so copy it or the link now.</p>
      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Invitation code</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-lg border bg-card px-3 py-2 font-mono text-base tracking-wider" data-testid="invite-code">{formatCode(created.code)}</code>
            <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => void run("code")}>{copied === "code" ? <Check aria-hidden /> : <Copy aria-hidden />} Copy code</Button>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Invitation link</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all rounded-lg border bg-card px-3 py-2 font-mono text-xs" data-testid="invite-link">{created.link}</code>
            <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => void run("link")}>{copied === "link" ? <Check aria-hidden /> : <Copy aria-hidden />} Copy link</Button>
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        {inviteUsage(created.invite)} · expires <time dateTime={created.invite.expiresAt}>{new Date(created.invite.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
        {created.invite.forEmail && " · for one specific person"}
      </p>
      <Button type="button" className="mt-4 rounded-xl" onClick={onDismiss}>I&apos;ve saved it</Button>
    </section>
  );
}
