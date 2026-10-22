"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Logo } from "@/components/brand/logo";
import { useState } from "react";
import { CommandSearch } from "./command-search";
import { SidebarNav } from "./sidebar-nav";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { findNavItem, type NavSection } from "./nav-config";

export function Topbar({ sections, user, unread }: { sections: NavSection[]; user: { name: string; email: string }; unread: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = findNavItem(pathname);
  const items = sections.flatMap((s) => s.items);

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-card/80 px-4 backdrop-blur sm:px-6">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="outline" size="icon" className="rounded-xl lg:hidden" aria-label="Open navigation menu">
            <Menu aria-hidden />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[19rem] gap-0 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Main navigation for StudyForge AI</SheetDescription>
          <div className="flex h-16 items-center border-b px-5"><Logo href="/workspace" /></div>
          <div className="flex-1 overflow-y-auto p-3"><SidebarNav sections={sections} onNavigate={() => setOpen(false)} /></div>
        </SheetContent>
      </Sheet>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold" aria-live="polite">{current?.label ?? "StudyForge"}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block size-1.5 rounded-full bg-success" aria-hidden />
          Personal workspace
        </p>
      </div>

      <div className="hidden w-56 md:block lg:hidden"><CommandSearch items={items} /></div>

      <ThemeToggle />
      <Button asChild variant="outline" size="icon" className="relative rounded-xl">
        <Link href="/notifications" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}>
          <Bell aria-hidden />
          {unread > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-destructive ring-2 ring-card" aria-hidden />}
        </Link>
      </Button>
      <div className="lg:hidden"><UserMenu name={user.name} email={user.email} variant="compact" /></div>
    </header>
  );
}
