import type { Metadata } from "next";
import { DraftNotice, ProsePage } from "@/components/common/prose-page";

export const metadata: Metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  return (
    <ProsePage title="Privacy policy" updated="October 2026">
      <DraftNotice />
      <h2>What we store today</h2>
      <ul>
        <li>Account details: name, email address and a salted password hash (we never store your password).</li>
        <li>Profile and preferences you choose to enter.</li>
        <li>Sign-in sessions (device description and timestamps) so you can review and revoke them.</li>
        <li>Notifications and a security audit log of sensitive account actions. Audit entries never contain passwords, tokens or private content; IP addresses are stored only as keyed one-way hashes.</li>
      </ul>
      <h2>Your controls</h2>
      <ul>
        <li>Export your data as JSON from Privacy &amp; account.</li>
        <li>Delete your account permanently at any time; related records are removed.</li>
        <li>Sign out other devices and change your password whenever you wish.</li>
      </ul>
      <h2>Coming with later modules</h2>
      <p>When document upload, AI providers and exams ship, this policy will be updated to cover uploaded files, encrypted provider keys, and the third-party AI providers you choose to connect. Administrators will not have access to your private documents, conversations, keys or answers.</p>
      <h2>Contact</h2>
      <p>The operator of this deployment is responsible for adding a contact address here.</p>
    </ProsePage>
  );
}
