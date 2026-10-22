import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/admin-header";
import { AdminNav } from "@/components/admin/admin-nav";
import { adminTabs, asRole, isAdminConsoleRole } from "@/lib/admin";
import { requireMe } from "@/lib/server/backend";

// Layouts don't re-run on client navigations, so each admin page also reads data through the backend, which answers 404 to anyone
// without the permission. This layout adds a first gate so non-staff never even see the frame (title, privacy note, tabs).
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe("/admin");
  if (!isAdminConsoleRole(me.user.role)) notFound();
  const role = asRole(me.user.role);
  return (
    <>
      <AdminHeader role={role} />
      <AdminNav tabs={adminTabs(role)} />
      {children}
    </>
  );
}
