import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BookOpenCheck, CheckCircle2, Circle, GraduationCap, ListChecks, MessagesSquare, PenLine } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/common/page-header";
import { VerifyEmailBanner } from "@/components/account/verify-email-banner";
import { backendJson, requireMe } from "@/lib/server/backend";
import { getT } from "@/lib/i18n/server";
import { msg } from "@/lib/i18n/translate";

export const metadata: Metadata = { title: "Workspace" };

type Summary = { providersConnected: number; hasDefaultModel: boolean; hasEmbeddingModel: boolean; documents: { total: number; ready: number }; conversations: number; questionsAsked: number };
type Profile = { displayName: string; bio: string; name: string };

const MODES = [
  { href: "/chat", title: msg("Conversation"), icon: MessagesSquare, text: msg("Chat with an AI tutor, or limit answers to your own uploaded documents — with sources."), tone: "bg-accent text-accent-foreground" },
  { href: "/mcq", title: msg("MCQ Generator"), icon: ListChecks, text: msg("Turn a topic, text or document into checked multiple-choice practice you can edit and save."), tone: "bg-success-soft text-success" },
  { href: "/cq", title: msg("CQ Generator"), icon: PenLine, text: msg("Create stimulus-based creative questions, with or without model answers."), tone: "bg-warning-soft text-warning" },
  { href: "/exams", title: msg("Exams"), icon: GraduationCap, text: msg("Build a timed multiple-choice exam from your question bank, take it, and see your marked results."), tone: "bg-accent text-accent-foreground" },
  { href: "/question-bank", title: msg("Question Bank"), icon: BookOpenCheck, text: msg("Search, organise and reuse your saved questions in private collections."), tone: "bg-info-soft text-primary" },
];

export default async function WorkspacePage() {
  const t = await getT();
  const me = await requireMe("/workspace");
  const [summary, profile] = await Promise.all([backendJson<Summary>("/api/dashboard/summary"), backendJson<Profile>("/api/profile")]);
  const firstName = me.user.name.split(" ")[0];

  const steps = [
    { done: true, label: t("Create your account") },
    { done: me.user.emailVerified, label: t("Verify your email address"), href: "/settings/privacy" },
    { done: Boolean(profile.bio || (profile.displayName && profile.displayName !== me.user.name)), label: t("Complete your profile"), href: "/settings/profile" },
    { done: summary.providersConnected > 0, label: t("Add an AI provider API key"), href: "/settings/providers" },
    { done: summary.hasDefaultModel, label: t("Choose your default model"), href: "/settings/providers" },
    { done: summary.hasEmbeddingModel, label: t("Choose an embedding model (needed to search documents)"), href: "/settings/providers" },
    { done: summary.documents.ready > 0, label: t("Upload and process your first document"), href: "/documents" },
    { done: summary.questionsAsked > 0, label: t("Ask your first question"), href: "/chat" },
  ];

  return (
    <>
      <PageHeader title={t("Welcome, {name}", { name: firstName })} description={t("Pick a study mode. Anything marked Soon in the sidebar is not available yet.")} />
      <VerifyEmailBanner verified={me.user.emailVerified} email={me.user.email} />
      <section aria-labelledby="modes" className="mb-8">
        <h2 id="modes" className="sr-only">{t("Study modes")}</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {MODES.map(({ href, title, icon: Icon, text, tone }) => (
            <Link key={href} href={href} className="group rounded-2xl border bg-card p-5 shadow-card transition hover:border-primary/40 focus-visible:outline-2">
              <div className="flex items-center justify-between">
                <span className={`inline-flex size-11 items-center justify-center rounded-2xl ${tone}`}><Icon className="size-5" aria-hidden /></span>
              </div>
              <h3 className="mt-4 font-semibold">{t(title)}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t(text)}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary">{t("Open")} <ArrowRight className="size-4 transition group-hover:translate-x-0.5" aria-hidden /></span>
            </Link>
          ))}
        </div>
      </section>

      <Card className="rounded-2xl shadow-card">
        <CardHeader>
          <CardTitle>{t("Getting started")}</CardTitle>
          <CardDescription>{t("Your real setup status. Each step completes when the feature is actually configured.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-3 py-3 text-sm">
                {s.done ? <CheckCircle2 className="size-5 text-success" aria-label={t("Done")} /> : <Circle className="size-5 text-muted-foreground" aria-label={t("Not done")} />}
                <span className={s.done ? "text-muted-foreground line-through" : "font-medium"}>{s.label}</span>
                {s.href && !s.done && <Link href={s.href} className="ml-auto text-primary hover:underline">{t("Open")}</Link>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
