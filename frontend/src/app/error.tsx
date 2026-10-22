"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  return (
    <main id="main-content" className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{t("Something went wrong")}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{t("An unexpected error occurred. Nothing was lost. You can try again.")}</p>
      {error.digest && <p className="text-xs text-muted-foreground">{t("Reference: {ref}", { ref: error.digest })}</p>}
      <Button onClick={reset} className="rounded-xl">{t("Try again")}</Button>
    </main>
  );
}
