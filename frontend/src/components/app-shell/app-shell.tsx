import { Logo } from "@/components/brand/logo";
import { CommandSearch } from "./command-search";
import { SidebarNav } from "./sidebar-nav";
import { ThemeSync } from "./theme-sync";
import { Topbar } from "./topbar";
import { UserMenu } from "./user-menu";
import { sectionsFor } from "./nav-config";

export function AppShell({
  user,
  unread,
  themePreference,
  children,
}: {
  user: { name: string; email: string; role: "USER" | "ADMIN" };
  unread: number;
  themePreference: "SYSTEM" | "LIGHT" | "DARK";
  children: React.ReactNode;
}) {
  const sections = sectionsFor(user.role === "ADMIN");
  const items = sections.flatMap((s) => s.items);
  return (
    <div className="h-dvh bg-background lg:p-3">
      <ThemeSync preference={themePreference} />
      <div className="flex h-full overflow-hidden bg-card lg:rounded-2xl lg:border lg:shadow-card">
        <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar lg:flex" aria-label="Sidebar">
          <div className="flex h-16 items-center px-5"><Logo href="/workspace" /></div>
          <div className="px-3 pb-3"><CommandSearch items={items} registerShortcut /></div>
          <div className="flex-1 overflow-y-auto px-3 pb-3"><SidebarNav sections={sections} /></div>
          <div className="border-t p-3"><UserMenu name={user.name} email={user.email} /></div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar sections={sections} user={user} unread={unread} />
          <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto bg-background/60 px-4 py-6 outline-none sm:px-6 lg:px-8">
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
