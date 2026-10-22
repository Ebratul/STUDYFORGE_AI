import type { Metadata } from "next";
import { JoinPreview } from "@/components/groups/join-panel";
import { normalizeCodeInput } from "@/lib/groups";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Join a group", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = normalizeCodeInput(raw);
  // Signed-out visitors are sent to sign in and brought back to this exact link.
  await requireMe(`/join/${encodeURIComponent(code)}`);
  return <JoinPreview code={code} />;
}
