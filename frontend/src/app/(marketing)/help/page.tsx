import type { Metadata } from "next";
import Link from "next/link";
import { ProsePage } from "@/components/common/prose-page";

export const metadata: Metadata = { title: "Help" };

export default function HelpPage() {
  return (
    <ProsePage title="Help">
      <h2>I can&apos;t sign in</h2>
      <p>Check your email and password, then use <Link href="/forgot-password" className="text-primary underline">Forgot password</Link>. After several failed attempts you may need to wait a minute.</p>
      <h2>I didn&apos;t get a verification or reset email</h2>
      <p>Check your spam folder. If the server operator has not configured email, these messages cannot be sent.</p>
      <h2>What can I do right now?</h2>
      <p>Today you can create an account, add your own AI provider key, upload documents, chat with sources, generate MCQs and CQs, keep them in a private question bank, and build and take timed multiple-choice exams (the server keeps the clock and does the marking). Anything marked <em>Soon</em> in the sidebar is not available yet.</p>
      <h2>How do I delete my account?</h2>
      <p>Go to Settings → Privacy &amp; account → Delete account.</p>
    </ProsePage>
  );
}
