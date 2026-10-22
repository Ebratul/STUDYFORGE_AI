import { Lock } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { PRIVACY_NOTE, ROLE_LABEL, type AdminRole } from "@/lib/admin";
import { AdminRoleBadge } from "./common";

/** Title, role badge and the privacy stance, shown on every admin page. */
export function AdminHeader({ role }: { role: AdminRole }) {
  return (
    <>
      <PageHeader
        title="Administration"
        description="Operations, accounts and security for the platform."
        actions={<span className="flex items-center gap-2 text-sm text-muted-foreground">Signed in as <AdminRoleBadge role={role} /><span className="sr-only">{ROLE_LABEL[role]}</span></span>}
        className="mb-4"
      />
      <p className="mb-4 flex items-start gap-2 rounded-xl border bg-muted/40 px-4 py-3 text-sm" data-testid="privacy-note">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>{PRIVACY_NOTE}{role === "SUPPORT" ? " Your role is read-only: account changes, job retries and configuration are not available." : ""}</span>
      </p>
    </>
  );
}
