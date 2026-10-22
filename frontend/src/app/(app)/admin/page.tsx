import type { Metadata } from "next";
import { Activity, ShieldCheck, UserCheck, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

type Overview = {
  users: number;
  verified: number;
  newUsers: number;
  sessions: number;
  events: { id: string; action: string; targetType: string | null; actor: string | null; createdAt: string }[];
};

// Admins see aggregates and audit metadata only — never user content. The backend answers 404 to non-admins,
// which backendJson turns into notFound(), so the page does not reveal that it exists.
export default async function AdminPage() {
  await requireMe("/admin");
  const o = await backendJson<Overview>("/api/admin/overview");
  return (
    <>
      <PageHeader title="Administration" description="Platform health at a glance. Private user content is intentionally not accessible here." />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total users" value={o.users} icon={Users} tone="violet" />
        <StatCard label="Verified emails" value={o.verified} icon={UserCheck} tone="green" hint={o.users ? `${Math.round((o.verified / o.users) * 100)}% of users` : undefined} />
        <StatCard label="New (7 days)" value={o.newUsers} icon={ShieldCheck} tone="amber" />
        <StatCard label="Active sessions" value={o.sessions} icon={Activity} tone="blue" />
      </div>
      <Card className="rounded-2xl shadow-card">
        <CardHeader>
          <CardTitle>Recent audit events</CardTitle>
          <CardDescription>Latest 20 events. Metadata and secrets are never shown.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Action</TableHead><TableHead>Target</TableHead><TableHead>Actor</TableHead></TableRow></TableHeader>
            <TableBody>
              {o.events.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">No events yet.</TableCell></TableRow>}
              {o.events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="font-medium">{e.action}</TableCell>
                  <TableCell>{e.targetType ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{e.actor ?? "system"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
