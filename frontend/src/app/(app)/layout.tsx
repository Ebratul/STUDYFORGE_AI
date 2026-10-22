import { AppShell } from "@/components/app-shell/app-shell";
import { requireMe } from "@/lib/server/backend";

// Layouts don't re-run on client-side navigations, so each page also calls requireMe(); the backend
// re-validates the session on every data request regardless.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe();
  return (
    <AppShell user={me.user} unread={me.unread} themePreference={me.preference.theme}>
      {children}
    </AppShell>
  );
}
