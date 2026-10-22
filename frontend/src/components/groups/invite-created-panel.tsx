"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatCode, inviteUsage, type CreatedInvite } from "@/lib/groups";
import { useI18n } from "@/lib/i18n/client";
import type { TFunction } from "@/lib/i18n/translate";

async function copy(text: string, what: "Code" | "Link", t: TFunction) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what === "Code" ? t("Code copied") : t("Link copied"));
    return true;
  } catch {
    toast.error(t("Couldn't copy automatically. Select the text and copy it manually."));
    return false;
  }
}

/** Shown once, right after creation. The code is never retrievable again (only its hash is stored). */
export function InviteCreatedPanel({ created, onDismiss }: { created: CreatedInvite; onDismiss: () => void }) {
  const { t, format } = useI18n();
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const run = async (kind: "code" | "link") => {
    if (await copy(kind === "code" ? created.code : created.link, kind === "code" ? "Code" : "Link", t)) setCopied(kind);
  };
  return (
    <section className="rounded-2xl border-2 border-primary/40 bg-accent/40 p-5" aria-labelledby="inv-new-h" data-testid="invite-created">
      <h2 id="inv-new-h" className="flex items-center gap-2 text-base font-semibold"><KeyRound className="size-4" aria-hidden /> {t("Your new invitation")}</h2>
      <p role="note" className="mt-1 text-sm font-medium">{t("This is the only time you'll see this code. We store only a scrambled version, so copy it or the link now.")}</p>
      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-muted-foreground">{t("Invitation code")}</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-lg border bg-card px-3 py-2 font-mono text-base tracking-wider" data-testid="invite-code">{formatCode(created.code)}</code>
            <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => void run("code")}>{copied === "code" ? <Check aria-hidden /> : <Copy aria-hidden />} {t("Copy code")}</Button>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("Invitation link")}</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all rounded-lg border bg-card px-3 py-2 font-mono text-xs" data-testid="invite-link">{created.link}</code>
            <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => void run("link")}>{copied === "link" ? <Check aria-hidden /> : <Copy aria-hidden />} {t("Copy link")}</Button>
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        {inviteUsage(created.invite, t)} · {t("expires")} <time dateTime={created.invite.expiresAt}>{format.dateTime(created.invite.expiresAt)}</time>
        {created.invite.forEmail && ` · ${t("for one specific person")}`}
      </p>
      <Button type="button" className="mt-4 rounded-xl" onClick={onDismiss}>{t("I've saved it")}</Button>
    </section>
  );
}
