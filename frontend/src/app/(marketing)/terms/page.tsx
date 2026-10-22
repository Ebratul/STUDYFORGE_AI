import type { Metadata } from "next";
import { DraftNotice, ProsePage } from "@/components/common/prose-page";

export const metadata: Metadata = { title: "Terms of service" };

export default function TermsPage() {
  return (
    <ProsePage title="Terms of service" updated="October 2026">
      <DraftNotice />
      <h2>Using StudyForge</h2>
      <p>StudyForge is a study aid. You are responsible for the material you upload and for having the right to use it. Do not use the service to attempt unauthorised access, abuse rate limits, or disrupt other users.</p>
      <h2>AI-generated content</h2>
      <p>AI output can be wrong. Always check important facts against your source material. Scores in exams are calculated deterministically by the platform, not by an AI model.</p>
      <h2>Accounts</h2>
      <p>Keep your credentials safe. You may delete your account at any time. We may suspend accounts that violate these terms.</p>
      <h2>Availability</h2>
      <p>The service is under active development and is provided as-is, without guarantees of uptime or fitness for a particular purpose.</p>
    </ProsePage>
  );
}
