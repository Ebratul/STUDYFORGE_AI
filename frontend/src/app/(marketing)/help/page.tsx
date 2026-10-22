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
      <p>Today you can create an account, manage your profile, preferences, sessions and data, and see where each upcoming module fits. Conversation, MCQ/CQ generation, documents, exams and groups are marked <em>Soon</em> in the sidebar and are not functional yet.</p>
      <h2>How do I delete my account?</h2>
      <p>Go to Settings → Privacy &amp; account → Delete account.</p>
    </ProsePage>
  );
}
