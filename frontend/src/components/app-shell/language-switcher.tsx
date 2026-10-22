"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Languages } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { apiGet, apiSend } from "@/lib/api";
import { catalogs } from "@/lib/i18n/catalog";
import { LOCALES, LOCALE_LABEL, type Locale } from "@/lib/i18n/config";
import { useLocale, useT, writeLocaleCookie } from "@/lib/i18n/client";
import { createT, msg } from "@/lib/i18n/translate";

type Profile = { preference: { theme: "SYSTEM" | "LIGHT" | "DARK"; locale: Locale; emailNotifications: boolean; autoAiFeedback?: boolean } };

/**
 * Switches the interface language. The choice is remembered in a cookie (instant, works signed out) and, when signed in, saved to the
 * account preference so it follows the user across devices. A polite live region announces the change in the new language.
 */
export function LanguageSwitcher({ signedIn = true }: { signedIn?: boolean }) {
  const t = useT();
  const current = useLocale();
  const router = useRouter();
  const [announce, setAnnounce] = useState("");

  async function choose(next: Locale) {
    if (next === current) return;
    writeLocaleCookie(next);
    const nt = createT(next, catalogs);
    setAnnounce(nt(msg("Language changed to {name}"), { name: LOCALE_LABEL[next] }));
    if (signedIn) {
      try {
        const { preference } = await apiGet<Profile>("/api/profile");
        await apiSend("PATCH", "/api/preferences", { ...preference, locale: next });
      } catch {
        toast.error(nt(msg("Your language was changed on this device, but couldn't be saved to your account.")));
      }
    }
    router.refresh();
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" className="rounded-xl" aria-label={t("Change language")}>
            <Languages aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("Language")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {LOCALES.map((l) => (
            <DropdownMenuItem key={l} lang={l} onSelect={() => void choose(l)}>
              {LOCALE_LABEL[l]}
              {current === l && <Check className="ml-auto" aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" aria-live="polite" className="sr-only">{announce}</span>
    </>
  );
}
