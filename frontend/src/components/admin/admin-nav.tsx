"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeTab, type AdminTab } from "@/lib/admin";
import { cn } from "@/lib/utils";

/** Secondary navigation for the console. A real list of links (no JS needed to navigate); the current page is marked with aria-current. */
export function AdminNav({ tabs }: { tabs: AdminTab[] }) {
  const current = activeTab(usePathname());
  return (
    <nav aria-label="Administration sections" className="mb-6 overflow-x-auto">
      <ul className="flex min-w-max gap-1 rounded-2xl border bg-card p-1 shadow-card">
        {tabs.map((t) => {
          const active = t.slug === current;
          return (
            <li key={t.slug}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn("block rounded-xl px-3.5 py-2 text-sm font-medium transition-colors", active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground")}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
