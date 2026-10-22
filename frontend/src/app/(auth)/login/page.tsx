import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">Sign in to continue to your workspace.</p>
      <Suspense><LoginForm /></Suspense>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New to StudyForge? <Link href="/register" className="font-medium text-primary hover:underline">Create an account</Link>
      </p>
    </>
  );
}
