import { getT } from "@/lib/i18n/server";
export function ProsePage({ title, updated, children }: { title: string; updated?: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {updated && <p className="mt-1 text-sm text-muted-foreground">Last updated {updated}</p>}
      <div className="mt-8 space-y-4 text-[15px] leading-7 text-foreground/90 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
        {children}
      </div>
    </article>
  );
}

export async function DraftNotice() {
  const t = await getT();
  return (
    <p className="rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm">
      <strong>{t("Draft template.")}</strong> This text describes the current foundation build and must be reviewed by the operator (and legal counsel where required) before a public launch.
    </p>
  );
}
