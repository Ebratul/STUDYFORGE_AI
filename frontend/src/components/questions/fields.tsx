"use client";

import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export function FieldError({ id, children }: { id?: string; children?: React.ReactNode }) {
  const t = useT();
  if (!children) return null;
  return <p id={id} role="alert" className="mt-1 text-xs font-medium text-destructive">{typeof children === "string" ? t(children) : children}</p>;
}

/** A number box that keeps what the user is typing ("0." stays "0.") and reports NaN while it isn't a number yet. */
export function NumberInput({
  id, value, onChange, min, max, step = 1, className, invalid, describedBy, "aria-label": ariaLabel, disabled,
}: {
  id?: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; className?: string;
  invalid?: boolean; describedBy?: string; "aria-label"?: string; disabled?: boolean;
}) {
  const [typed, setText] = useState(Number.isFinite(value) ? String(value) : "");
  // Keep what the user is typing ("0." stays "0.") while it still means `value`; otherwise show the current value.
  const text = typed.trim() !== "" && Number(typed) === value ? typed : Number.isFinite(value) ? String(value) : "";
  return (
    <Input
      id={id}
      type="number"
      inputMode="decimal"
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={cn("h-10 rounded-xl", className)}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.trim() === "" ? Number.NaN : Number(e.target.value));
      }}
    />
  );
}

export type SegmentedOption<T extends string> = { value: T; label: string; hint?: string; disabled?: boolean; disabledReason?: string };

/** Radio group drawn as buttons. Native radios underneath, so arrow keys, labels and screen readers behave. */
export function Segmented<T extends string>({
  legend, name, value, options, onChange, className, hideLegend,
}: { legend: string; name: string; value: T; options: SegmentedOption<T>[]; onChange: (v: T) => void; className?: string; hideLegend?: boolean }) {
  return (
    <fieldset className={cn("min-w-0", className)}>
      <legend className={cn("mb-1.5 text-sm font-medium", hideLegend && "sr-only")}>{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const id = `${name}-${o.value}`;
          return (
            <div key={o.value} className="min-w-0">
              <input id={id} type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} className="peer sr-only" />
              <label
                htmlFor={id}
                title={o.disabled ? o.disabledReason : o.hint}
                className="flex min-h-11 cursor-pointer items-center rounded-xl border bg-background px-3.5 text-sm font-medium transition peer-checked:border-primary peer-checked:bg-accent peer-checked:text-accent-foreground peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 sm:min-h-10"
              >
                {o.label}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export function SwitchRow({ label, description, checked, onChange, disabled }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-start justify-between gap-3 rounded-xl border p-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
        {description && <p id={`${id}-d`} className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-describedby={description ? `${id}-d` : undefined} className="mt-0.5" />
    </div>
  );
}

export function Field({ label, htmlFor, hint, error, children, className }: { label: string; htmlFor: string; hint?: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error && <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      <FieldError id={`${htmlFor}-err`}>{error}</FieldError>
    </div>
  );
}
