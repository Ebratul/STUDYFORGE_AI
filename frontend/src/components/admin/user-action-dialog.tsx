"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { describeUserAction, type UserAction } from "@/lib/admin";

const MIN_REASON = 3;

/** Confirmation for a sensitive account action, with a reason that goes to the audit log. Suspending requires a reason. */
export function UserActionDialog({ action, userId, userName, pending, error, onCancel, onConfirm }: {
  action: UserAction | null; userId: string; userName: string; pending: boolean; error: string | null; onCancel: () => void; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  if (!action) return null;
  const d = describeUserAction(action, userName);
  const needsReason = action.kind === "status" && action.status === "SUSPENDED";
  const reasonError = needsReason && touched && reason.trim().length < MIN_REASON ? "Enter a short reason (it is recorded in the audit log)." : null;
  const destructive = action.kind === "revoke" || (action.kind === "status" && action.status === "SUSPENDED") || (action.kind === "role" && action.role === "USER");
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !pending) onCancel(); }}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          // The dropdown item that opened this dialog is gone by now: hand focus back to the row's actions button instead of <body>.
          e.preventDefault();
          document.querySelector<HTMLElement>(`[data-user-id="${CSS.escape(userId)}"] button[aria-label^="Actions for"]`)?.focus();
        }}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (needsReason && reason.trim().length < MIN_REASON) return;
            onConfirm(reason);
          }}
        >
          <DialogHeader><DialogTitle>{d.title}</DialogTitle><DialogDescription>{d.description}</DialogDescription></DialogHeader>
          {action.kind !== "revoke" && (
            <div className="space-y-1.5">
              <Label htmlFor="admin-reason">Reason {needsReason ? "" : "(optional)"}</Label>
              <Textarea id="admin-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} className="rounded-xl" aria-invalid={reasonError ? true : undefined} aria-describedby={reasonError ? "admin-reason-err" : undefined} />
              {reasonError && <p id="admin-reason-err" className="text-sm text-destructive">{reasonError}</p>}
            </div>
          )}
          {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" className="rounded-xl" onClick={onCancel} disabled={pending}>Cancel</Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} className="rounded-xl" disabled={pending}>{pending && <Loader2 className="animate-spin" aria-hidden />} {d.confirm}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
