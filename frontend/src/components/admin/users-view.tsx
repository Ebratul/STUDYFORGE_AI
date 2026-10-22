"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MoreHorizontal, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiGet, apiSend } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { canManageUsers, clampPage, emailDisplay, formatCount, readPaged, readUserRow, ROLE_SHORT, STATUS_LABEL, userPatchBody, type AdminRole, type UserAction, type UserRow } from "@/lib/admin";
import { describeAdminError, USERS_PAGE_SIZE, usersPath, type UserFilters } from "@/lib/admin-api";
import { AdminRoleBadge, Chip, ErrorLine, LoadingRows, Pager, Panel } from "./common";
import { UserActionDialog } from "./user-action-dialog";

const selectCls = "h-10 w-full rounded-xl border bg-background px-3 text-sm";
const dateOnly = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");

export function UsersView({ role, selfId }: { role: AdminRole; selfId: string }) {
  const qc = useQueryClient();
  const mayManage = canManageUsers(role);
  const [input, setInput] = useState("");
  const [filters, setFilters] = useState<UserFilters>({ q: "", status: "", role: "" });
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<{ user: UserRow; action: UserAction } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // debounce the search box so we don't query on every key
  useEffect(() => {
    const t = setTimeout(() => { setFilters((f) => (f.q === input.trim() ? f : { ...f, q: input.trim() })); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [input]);

  const users = useQuery({ queryKey: ["admin", "users", filters, page], queryFn: async () => readPaged(await apiGet(usersPath(filters, page)), readUserRow, USERS_PAGE_SIZE), placeholderData: (p) => p });
  const data = users.data;

  const act = useMutation({
    mutationFn: async (v: { user: UserRow; action: UserAction; reason: string }) =>
      v.action.kind === "revoke" ? apiSend("POST", `/api/admin/users/${encodeURIComponent(v.user.id)}/revoke-sessions`, {}) : apiSend("PATCH", `/api/admin/users/${encodeURIComponent(v.user.id)}`, userPatchBody(v.action, v.reason)),
    onSuccess: (_r, v) => {
      setPending(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["admin"] });
      toast.success(v.action.kind === "revoke" ? `Signed ${v.user.name} out everywhere` : v.action.kind === "status" ? `${v.user.name} is now ${STATUS_LABEL[v.action.status].toLowerCase()}` : `${v.user.name} is now ${ROLE_SHORT[v.action.role]}`);
    },
    onError: (e) => setError(describeAdminError(e)),
  });

  const patch = (p: Partial<UserFilters>) => { setFilters((f) => ({ ...f, ...p })); setPage(1); };
  const total = data?.total ?? 0;

  return (
    <>
      <Panel id="users-h" title="Users" description={mayManage ? "Search accounts, suspend or reactivate them, change roles and revoke sessions. Every change is audited." : "Read-only view of account metadata."}>
        <form role="search" aria-label="Filter users" className="grid gap-3 border-b p-5 sm:grid-cols-[1fr_10rem_10rem]" onSubmit={(e) => e.preventDefault()}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input type="search" aria-label="Search users" placeholder="Search by name or e-mail" value={input} onChange={(e) => setInput(e.target.value)} className="h-10 rounded-xl pl-9" maxLength={100} />
          </div>
          <select aria-label="Status" className={selectCls} value={filters.status} onChange={(e) => patch({ status: e.target.value as UserFilters["status"] })}>
            <option value="">Any status</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option>
          </select>
          <select aria-label="Role" className={selectCls} value={filters.role} onChange={(e) => patch({ role: e.target.value as UserFilters["role"] })}>
            <option value="">Any role</option><option value="USER">User</option><option value="SUPPORT">Support</option><option value="ADMIN">Administrator</option>
          </select>
        </form>
        {users.isLoading && <LoadingRows />}
        {users.isError && <ErrorLine message={describeAdminError(users.error)} />}
        {data && (
          <>
            <p className="px-5 pt-3 text-sm text-muted-foreground" aria-live="polite" data-testid="users-total">{formatCount(total)} {total === 1 ? "user" : "users"}</p>
            <Table data-testid="users-table" scrollLabel="Accounts matching the current filters">
              <TableCaption className="sr-only">Accounts matching the current filters</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">User</TableHead><TableHead scope="col">Role</TableHead><TableHead scope="col">Status</TableHead>
                  <TableHead scope="col" className="text-right">Documents</TableHead><TableHead scope="col" className="text-right">Storage</TableHead><TableHead scope="col" className="text-right">Tokens (30 d)</TableHead>
                  <TableHead scope="col">Last session</TableHead>
                  <TableHead scope="col" className="w-12"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.length === 0 && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No users match these filters.</TableCell></TableRow>}
                {data.items.map((u) => {
                  const mail = emailDisplay(u.email);
                  const self = u.id === selfId;
                  return (
                    <TableRow key={u.id} data-testid="user-row" data-user-id={u.id}>
                      <TableCell className="max-w-64">
                        <p className="flex items-center gap-2 font-medium"><span className="truncate">{u.name}</span>{self && <Chip>You</Chip>}</p>
                        <p className="truncate text-xs text-muted-foreground">{mail.text}{mail.masked && <span className="ml-1">(masked)</span>}{!u.emailVerified && <span className="ml-1">· unverified</span>}</p>
                      </TableCell>
                      <TableCell><AdminRoleBadge role={u.role} /></TableCell>
                      <TableCell>{u.status === "SUSPENDED" ? <Chip tone="danger"><ShieldAlert className="size-3.5" aria-hidden /> Suspended</Chip> : <Chip tone="success"><CheckCircle2 className="size-3.5" aria-hidden /> Active</Chip>}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(u.documents)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(u.storageBytes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(u.tokens30d)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{dateOnly(u.lastSessionAt)}</TableCell>
                      <TableCell>
                        {mayManage && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="rounded-xl" aria-label={`Actions for ${u.name}`}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              {self ? <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">You can&apos;t change your own role or status.</DropdownMenuLabel> : (
                                <>
                                  {u.status === "ACTIVE"
                                    ? <DropdownMenuItem onSelect={() => { setError(null); setPending({ user: u, action: { kind: "status", status: "SUSPENDED" } }); }}>Suspend account…</DropdownMenuItem>
                                    : <DropdownMenuItem onSelect={() => { setError(null); setPending({ user: u, action: { kind: "status", status: "ACTIVE" } }); }}>Reactivate account…</DropdownMenuItem>}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Change role</DropdownMenuLabel>
                                  {(["USER", "SUPPORT", "ADMIN"] as const).filter((r) => r !== u.role).map((r) => (
                                    <DropdownMenuItem key={r} onSelect={() => { setError(null); setPending({ user: u, action: { kind: "role", role: r } }); }}>Make {ROLE_SHORT[r].toLowerCase()}…</DropdownMenuItem>
                                  ))}
                                  <DropdownMenuSeparator />
                                </>
                              )}
                              <DropdownMenuItem onSelect={() => { setError(null); setPending({ user: u, action: { kind: "revoke" } }); }}>Revoke all sessions…</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Pager page={clampPage(page, total, USERS_PAGE_SIZE)} total={total} pageSize={USERS_PAGE_SIZE} onPage={setPage} label="Users" />
          </>
        )}
      </Panel>
      <UserActionDialog
        key={pending ? `${pending.user.id}:${pending.action.kind}` : "none"}
        action={pending?.action ?? null}
        userId={pending?.user.id ?? ""}
        userName={pending?.user.name ?? ""}
        pending={act.isPending}
        error={error}
        onCancel={() => { setPending(null); setError(null); }}
        onConfirm={(reason) => pending && act.mutate({ user: pending.user, action: pending.action, reason })}
      />
    </>
  );
}
