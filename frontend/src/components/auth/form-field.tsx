"use client";

import { useId, useState, forwardRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = React.ComponentProps<typeof Input> & { label: string; error?: string; hint?: string };

export const FormField = forwardRef<HTMLInputElement, Props>(function FormField({ label, error, hint, className, id, ...props }, ref) {
  const auto = useId();
  const fieldId = id ?? auto;
  const describedBy = [error ? `${fieldId}-error` : null, hint ? `${fieldId}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input ref={ref} id={fieldId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={cn("h-10 rounded-xl", className)} {...props} />
      {hint && !error && <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${fieldId}-error`} role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
});

export const PasswordField = forwardRef<HTMLInputElement, Omit<Props, "type">>(function PasswordField({ label, error, hint, className, id, ...props }, ref) {
  const auto = useId();
  const fieldId = id ?? auto;
  const [visible, setVisible] = useState(false);
  const describedBy = [error ? `${fieldId}-error` : null, hint ? `${fieldId}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="relative">
        <Input ref={ref} id={fieldId} type={visible ? "text" : "password"} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={cn("h-10 rounded-xl pr-10", className)} {...props} />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
        >
          {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
      {hint && !error && <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${fieldId}-error`} role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
});
