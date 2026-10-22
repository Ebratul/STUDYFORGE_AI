import type { Metadata } from "next";
import Link from "next/link";
import { RegisterForm } from "@/components/auth/register-form";
import { getRich, getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Create account" };

export default async function RegisterPage() {
  const t = await getT();
  const rich = await getRich();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{t("Create your account")}</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">{t("Free to start. Bring your own AI provider key later.")}</p>
      <RegisterForm />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        {rich("Already have an account? {link}", { link: <Link href="/login" className="font-medium text-primary hover:underline">{t("Sign in")}</Link> })}
      </p>
    </>
  );
}
