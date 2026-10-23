import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { GoogleButtonView, GoogleSignIn } from "@/components/auth/google-sign-in";
import { LoginForm } from "@/components/auth/login-form";
import { getAuthProviders } from "@/lib/server/backend";
import { getRich, getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  const t = await getT();
  const rich = await getRich();
  const { google } = await getAuthProviders();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{t("Welcome back")}</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">{t("Sign in to continue to your workspace.")}</p>
      <Suspense fallback={google ? <GoogleButtonView disabled /> : null}><GoogleSignIn mode="login" enabled={google} /></Suspense>
      <Suspense><LoginForm /></Suspense>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        {rich("New to StudyForge? {link}", { link: <Link href="/register" className="font-medium text-primary hover:underline">{t("Create an account")}</Link> })}
      </p>
    </>
  );
}
