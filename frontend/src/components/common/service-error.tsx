"use client";

import { useRouter } from "next/navigation";
import { CloudOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";

export function ServiceError({ title, message }: { title?: string; message: string }) {
  const router = useRouter();
  const t = useT();
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center">
      <CloudOff className="size-8 text-destructive" aria-hidden />
      <h2 className="text-base font-semibold">{title ?? t("This service is unavailable")}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" className="rounded-xl" onClick={() => router.refresh()}>{t("Try again")}</Button>
    </div>
  );
}
