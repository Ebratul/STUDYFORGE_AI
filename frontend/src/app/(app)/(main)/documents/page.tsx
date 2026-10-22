import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { DocumentLibrary, type DocumentView, type Limits } from "@/components/documents/document-library";
import { backendJson, requireMe } from "@/lib/server/backend";
import type { PreferencesResponse } from "@/lib/ai";

export const metadata: Metadata = { title: "Documents" };

export default async function DocumentsPage() {
  await requireMe("/documents");
  const [docs, limits, prefs] = await Promise.all([
    backendJson<{ items: DocumentView[] }>("/api/documents"),
    backendJson<Limits>("/api/documents/limits"),
    backendJson<PreferencesResponse>("/api/ai/preferences"),
  ]);
  return (
    <>
      <PageHeader title="Documents" description="Upload PDF, DOCX, Markdown and text files. They're private, processed in the background, and used only to answer your own questions." />
      <DocumentLibrary initialDocs={docs.items} initialLimits={limits} hasEmbedding={Boolean(prefs.tasks.EMBEDDING)} />
    </>
  );
}
