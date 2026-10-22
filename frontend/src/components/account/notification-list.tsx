"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiSend } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useFormat, useT } from "@/lib/i18n/client";

type Item = { id: string; title: string; body: string; link?: string | null; read: boolean; createdAt: string };

export function NotificationList({ items }: { items: Item[] }) {
  const t = useT();
  const format = useFormat();
  const router = useRouter();
  const [pending, start] = useTransition();
  const unread = items.filter((i) => !i.read).length;

  function run(fn: () => Promise<unknown>) {
    start(async () => {
      try {
        await fn();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("Something went wrong."));
      }
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border bg-card shadow-card">
      <div className="flex items-center justify-between border-b px-5 py-3">
        <p className="text-sm text-muted-foreground">{t("{count} unread", { count: unread })}</p>
        <Button size="sm" variant="outline" className="rounded-xl" disabled={pending || unread === 0} onClick={() => run(() => apiSend("POST", "/api/notifications/read-all"))}>
          <CheckCheck aria-hidden /> {t("Mark all read")}
        </Button>
      </div>
      <ul className="divide-y">
        {items.map((n) => (
          <li key={n.id} className={cn("flex items-start gap-3 px-5 py-4", !n.read && "bg-accent/40")}>
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t(n.title)}{!n.read && <span className="sr-only"> {t("(unread)")}</span>}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{t(n.body)}</p>
              <time className="mt-1 block text-xs text-muted-foreground" dateTime={n.createdAt}>{format.dateTime(n.createdAt)}</time>
              {n.link && n.link.startsWith("/") && !n.link.startsWith("//") && (
                <Link href={n.link} className="mt-1 inline-block text-sm font-medium text-primary underline-offset-2 hover:underline" onClick={() => { if (!n.read) void apiSend("POST", `/api/notifications/${n.id}/read`).catch(() => undefined); }}>
                  {t("Open")}<span className="sr-only"> “{t(n.title)}”</span>
                </Link>
              )}
            </div>
            {!n.read && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => apiSend("POST", `/api/notifications/${n.id}/read`))}>{t("Mark read")}</Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
