"use client";

import { Gauge } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { taskLabel, usageBar, type UsageData, type UsageWindow } from "@/lib/usage";
import { useI18n, useT } from "@/lib/i18n/client";

function Window({ title, testKey, w, resetNote }: { title: string; testKey: string; w: UsageWindow; resetNote: string }) {
  const i18n = useI18n();
  const { t, format } = i18n;
  const rows = [{ label: t("Requests"), used: w.requests, limit: w.requestLimit }, { label: t("Tokens"), used: w.tokens, limit: w.tokenLimit }];
  return (
    <section aria-label={t("{title} usage", { title })} data-testid={`usage-${testKey}`}>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="space-y-3">
        {rows.map((r) => {
          const bar = usageBar(r.used, r.limit, i18n);
          return (
            <div key={r.label}>
              <div className="mb-1 flex justify-between text-sm"><span>{r.label}</span><span className={bar.nearLimit ? "font-medium text-destructive" : "text-muted-foreground"}>{bar.label}{bar.nearLimit ? ` · ${t("almost at the limit")}` : ""}</span></div>
              <Progress value={bar.pct} aria-label={t("{title} {label} used", { title, label: r.label })} />
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{resetNote}{w.resetsAt ? ` ${format.dateTime(w.resetsAt)} ${t("(UTC-based).")}` : ""}</p>
    </section>
  );
}

/** Daily and monthly AI usage with the last 30 days by task. Shows what the provider reported; never a cost. */
export function UsageCard({ usage }: { usage: UsageData }) {
  const t = useT();
  const { format } = useI18n();
  const total = usage.byTask.reduce((n, x) => n + x.tokens, 0);
  return (
    <Card className="mb-6 rounded-2xl shadow-card" data-testid="usage-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Gauge className="size-4 text-primary" aria-hidden /> {t("Your AI usage")}</CardTitle>
        <CardDescription>{t("Limits protect your provider budget. A limit of “no limit” means StudyForge isn't capping that window (your provider may still).")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          <Window title={t("Today")} testKey="today" w={usage.daily} resetNote={t("Resets at")} />
          {usage.monthly ? <Window title={t("This month")} testKey="this month" w={usage.monthly} resetNote={t("Resets at")} /> : <p className="text-sm text-muted-foreground">{t("No monthly limit is configured.")}</p>}
        </div>
        <section aria-labelledby="usage-task-h">
          <h3 id="usage-task-h" className="mb-2 text-sm font-semibold">{t("Last 30 days by feature")}</h3>
          {usage.byTask.length === 0 ? <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground" data-testid="usage-empty">{t("No AI requests in the last 30 days.")}</p> : (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{t("AI requests and tokens by feature, last 30 days")}</caption>
                <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th scope="col" className="px-3 py-2 font-medium">{t("Feature")}</th><th scope="col" className="px-3 py-2 text-right font-medium">{t("Requests")}</th><th scope="col" className="px-3 py-2 text-right font-medium">{t("Tokens")}</th></tr></thead>
                <tbody>
                  {usage.byTask.map((x) => <tr key={x.task} className="border-t"><th scope="row" className="px-3 py-2 font-normal">{t(taskLabel(x.task))}</th><td className="px-3 py-2 text-right tabular-nums">{format.number(x.requests)}</td><td className="px-3 py-2 text-right tabular-nums">{format.number(x.tokens)}</td></tr>)}
                </tbody>
                <tfoot><tr className="border-t bg-muted/30 text-xs"><th scope="row" className="px-3 py-2 text-left font-medium">{t("Total")}</th><td className="px-3 py-2" /><td className="px-3 py-2 text-right tabular-nums font-medium">{format.number(total)}</td></tr></tfoot>
              </table>
            </div>
          )}
        </section>
        <p className="text-xs text-muted-foreground" data-testid="usage-note">{t(usage.note)}</p>
      </CardContent>
    </Card>
  );
}
