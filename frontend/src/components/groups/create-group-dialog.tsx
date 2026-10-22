"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NumberInput } from "@/components/questions/fields";
import { ApiError, apiSend } from "@/lib/api";
import { describeGroupError, GROUP_FIELD, type GroupLimits } from "@/lib/groups";

export function CreateGroupDialog({ open, onOpenChange, limits }: { open: boolean; onOpenChange: (o: boolean) => void; limits: GroupLimits }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [capacity, setCapacity] = useState(limits.groupDefaultCapacity);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const titleError = !title.trim() ? "Give the group a name." : title.trim().length > GROUP_FIELD.title ? `Use at most ${GROUP_FIELD.title} characters.` : undefined;
  const capError = !Number.isInteger(capacity) || capacity < 2 || capacity > limits.groupMaxCapacity ? `Choose a whole number from 2 to ${limits.groupMaxCapacity}.` : undefined;
  const descError = description.length > GROUP_FIELD.description ? `Use at most ${GROUP_FIELD.description} characters.` : undefined;

  const create = useMutation({
    mutationFn: () => apiSend<{ group: { id: string } }>("POST", "/api/groups", { title: title.trim(), description: description.trim() || null, capacity }),
    onSuccess: ({ group }) => {
      void qc.invalidateQueries({ queryKey: ["groups"] });
      toast.success("Group created");
      onOpenChange(false);
      router.push(`/groups/${group.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setServerErrors(err.fields);
        setError(Object.keys(err.fields).length ? null : describeGroupError(err));
      } else setError("Something went wrong. Please try again.");
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            setError(null);
            setServerErrors({});
            if (!titleError && !capError && !descError) create.mutate();
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>Create a study group</DialogTitle>
            <DialogDescription>You become the owner. Invite people with a private code or link, then publish exams for the whole group.</DialogDescription>
          </DialogHeader>
          <Field label="Group name" htmlFor="group-title" error={(touched ? titleError : undefined) ?? serverErrors.title}>
            <Input id="group-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={GROUP_FIELD.title + 20} autoComplete="off" className="h-10 rounded-xl" aria-invalid={(touched && titleError) || serverErrors.title ? true : undefined} />
          </Field>
          <Field label="Description (optional)" htmlFor="group-desc" error={descError ?? serverErrors.description}>
            <Textarea id="group-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="rounded-xl" />
          </Field>
          <Field label="Member capacity" htmlFor="group-capacity" hint={`Including you. Up to ${limits.groupMaxCapacity}.`} error={(touched ? capError : undefined) ?? serverErrors.capacity}>
            <NumberInput id="group-capacity" value={capacity} onChange={setCapacity} min={2} max={limits.groupMaxCapacity} invalid={Boolean(touched && capError)} />
          </Field>
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" className="rounded-xl" disabled={create.isPending}>{create.isPending && <Loader2 className="animate-spin" aria-hidden />} Create group</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
