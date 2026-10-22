"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import type { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { loginSchema } from "@/lib/validation/profile";
import { safeNextPath } from "@/lib/safe-next";
import { FormField, PasswordField } from "./form-field";

type Values = z.input<typeof loginSchema>;

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register, handleSubmit, formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });

  async function onSubmit(values: Values) {
    setFormError(null);
    const parsed = loginSchema.parse(values);
    const { error } = await authClient.signIn.email({ email: parsed.email, password: parsed.password });
    if (error) {
      if (error.status === 403) {
        setFormError("Please verify your email address first. We've sent you a fresh verification link.");
      } else if (error.status === 429) {
        setFormError("Too many attempts. Please wait a minute and try again.");
      } else {
        // Same message for unknown email and wrong password (no account enumeration).
        setFormError("Incorrect email or password.");
      }
      return;
    }
    router.replace(safeNextPath(params.get("next")));
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4" aria-label="Sign in">
      {params.get("reset") === "1" && (
        <Alert><AlertDescription>Your password was updated. Sign in with the new password.</AlertDescription></Alert>
      )}
      {formError && (
        <Alert variant="destructive" role="alert"><AlertDescription>{formError}</AlertDescription></Alert>
      )}
      <FormField label="Email" type="email" autoComplete="email" inputMode="email" error={errors.email?.message} {...register("email")} />
      <PasswordField label="Password" autoComplete="current-password" error={errors.password?.message} {...register("password")} />
      <div className="flex justify-end">
        <Link href="/forgot-password" className="text-sm font-medium text-primary hover:underline">Forgot password?</Link>
      </div>
      <Button type="submit" className="h-10 w-full rounded-xl" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" aria-hidden />} Sign in
      </Button>
    </form>
  );
}
