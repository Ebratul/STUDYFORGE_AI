"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, MailCheck } from "lucide-react";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { passwordSchema } from "@/lib/validation/password";
import { registerSchema } from "@/lib/validation/profile";
import { FormField, PasswordField } from "./form-field";

const schema = registerSchema
  .extend({ password: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match." });
type Values = z.input<typeof schema>;

export function RegisterForm() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  const {
    register, handleSubmit, formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: "", email: "", password: "", confirmPassword: "" } });

  async function onSubmit(values: Values) {
    setFormError(null);
    const v = schema.parse(values);
    const { data, error } = await authClient.signUp.email({ name: v.name, email: v.email, password: v.password, callbackURL: "/verify-email?status=done" });
    if (error) {
      if (error.status === 429) setFormError("Too many attempts. Please wait a minute and try again.");
      else if (error.code === "USER_ALREADY_EXISTS" || error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")
        setFormError("We couldn't create an account with those details. If you already registered, sign in or reset your password.");
      else setFormError(error.message || "We couldn't create your account. Please check your details and try again.");
      return;
    }
    // No session token => email verification is required before sign-in.
    if (!data?.token) {
      setCheckEmail(v.email);
      return;
    }
    router.replace("/workspace");
    router.refresh();
  }

  if (checkEmail) {
    return (
      <div className="space-y-3 text-center" role="status">
        <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-success-soft text-success"><MailCheck className="size-6" aria-hidden /></span>
        <h2 className="text-lg font-semibold">Check your inbox</h2>
        <p className="text-sm text-muted-foreground">If <strong>{checkEmail}</strong> can be registered, a verification link is on its way. Open it to activate your account.</p>
        <Button asChild variant="outline" className="rounded-xl"><Link href="/login">Back to sign in</Link></Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4" aria-label="Create account">
      {formError && <Alert variant="destructive" role="alert"><AlertDescription>{formError}</AlertDescription></Alert>}
      <FormField label="Full name" autoComplete="name" error={errors.name?.message} {...register("name")} />
      <FormField label="Email" type="email" autoComplete="email" inputMode="email" error={errors.email?.message} {...register("email")} />
      <PasswordField label="Password" autoComplete="new-password" hint="At least 10 characters, with a letter and a number." error={errors.password?.message} {...register("password")} />
      <PasswordField label="Confirm password" autoComplete="new-password" error={errors.confirmPassword?.message} {...register("confirmPassword")} />
      <Button type="submit" className="h-10 w-full rounded-xl" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" aria-hidden />} Create account
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        By creating an account you agree to the <Link href="/terms" className="underline">Terms</Link> and <Link href="/privacy" className="underline">Privacy Policy</Link>.
      </p>
    </form>
  );
}
