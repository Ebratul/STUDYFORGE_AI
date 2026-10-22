"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, MailCheck } from "lucide-react";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { passwordSchema } from "@/lib/validation/password";
import { FormField, PasswordField } from "./form-field";
import { useT } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email(msg("Enter a valid email address.")) });

export function ForgotPasswordForm() {
  const t = useT();
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.input<typeof forgotSchema>>({ resolver: zodResolver(forgotSchema), defaultValues: { email: "" } });

  async function onSubmit(values: z.input<typeof forgotSchema>) {
    setFormError(null);
    const { email } = forgotSchema.parse(values);
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    if (error?.status === 429) {
      setFormError(t("Too many requests. Please wait a minute and try again."));
      return;
    }
    // Identical outcome whether or not the account exists.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="space-y-3 text-center" role="status">
        <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-success-soft text-success"><MailCheck className="size-6" aria-hidden /></span>
        <h2 className="text-lg font-semibold">{t("Check your inbox")}</h2>
        <p className="text-sm text-muted-foreground">{t("If an account exists for that address, we've sent a link to reset your password. It expires in one hour.")}</p>
        <Button asChild variant="outline" className="rounded-xl"><Link href="/login">{t("Back to sign in")}</Link></Button>
      </div>
    );
  }
  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4" aria-label={t("Request password reset")}>
      {formError && <Alert variant="destructive" role="alert"><AlertDescription>{formError}</AlertDescription></Alert>}
      <FormField label={t("Email")} type="email" autoComplete="email" inputMode="email" error={errors.email?.message} {...register("email")} />
      <Button type="submit" className="h-10 w-full rounded-xl" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" aria-hidden />} {t("Send reset link")}
      </Button>
    </form>
  );
}

const resetSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: msg("Passwords do not match.") });

export function ResetPasswordForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");
  const linkInvalid = !token || params.get("error") === "INVALID_TOKEN";
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.input<typeof resetSchema>>({ resolver: zodResolver(resetSchema), defaultValues: { password: "", confirmPassword: "" } });

  if (linkInvalid) {
    return (
      <div className="space-y-3 text-center" role="alert">
        <h2 className="text-lg font-semibold">{t("This reset link isn't valid")}</h2>
        <p className="text-sm text-muted-foreground">{t("It may have expired or already been used. Request a new one.")}</p>
        <Button asChild className="rounded-xl"><Link href="/forgot-password">{t("Request a new link")}</Link></Button>
      </div>
    );
  }

  async function onSubmit(values: z.input<typeof resetSchema>) {
    setFormError(null);
    const v = resetSchema.parse(values);
    const { error } = await authClient.resetPassword({ newPassword: v.password, token: token! });
    if (error) {
      setFormError(error.status === 429 ? t("Too many attempts. Please wait a minute.") : t("This reset link is invalid or has expired. Request a new one."));
      return;
    }
    router.replace("/login?reset=1");
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4" aria-label={t("Choose a new password")}>
      {formError && <Alert variant="destructive" role="alert"><AlertDescription>{formError}</AlertDescription></Alert>}
      <PasswordField label={t("New password")} autoComplete="new-password" hint={t("At least 10 characters, with a letter and a number.")} error={errors.password?.message} {...register("password")} />
      <PasswordField label={t("Confirm new password")} autoComplete="new-password" error={errors.confirmPassword?.message} {...register("confirmPassword")} />
      <Button type="submit" className="h-10 w-full rounded-xl" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" aria-hidden />} {t("Update password")}
      </Button>
    </form>
  );
}
