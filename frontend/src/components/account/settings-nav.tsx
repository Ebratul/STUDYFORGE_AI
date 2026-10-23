"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

const LINKS = [
  { href: "/settings/profile", label: msg("Profile & preferences") },
  { href: "/settings/privacy", label: msg("Privacy & account") },
  { href: "/settings/providers", label: msg("AI connection") },
];

export function SettingsNav() {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav aria-label={t("Settings")} className="flex gap-1 overflow-x-auto lg:flex-col">
      {LINKS.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn("whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-colors", active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
          >
            {t(l.label)}
          </Link>
        );
      })}
    </nav>
  );
}
