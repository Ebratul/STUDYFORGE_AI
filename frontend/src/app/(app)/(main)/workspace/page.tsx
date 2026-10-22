import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, ListChecks, MessagesSquare, PenLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/common/page-header";
import { VerifyEmailBanner } from "@/components/account/verify-email-banner";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Workspace" };

type Summary = { providersConnected: number; hasDefaultModel: boolean; hasEmbeddingModel: boolean; documents: { total: number; ready: number }; conversations: number; questionsAsked: number };
type Profile = { displayName: string; bio: string; name: string };

const MODES = [
  { href: "/chat", title: "Conversation", icon: MessagesSquare, ready: true, text: "Chat with an AI tutor, or limit answers to your own uploaded documents — with sources.", tone: "bg-accent text-accent-foreground" },
  { href: "/mcq", title: "MCQ Generator", icon: ListChecks, ready: false, part: 3, text: "Turn a topic, text or document into validated multiple-choice practice.", tone: "bg-success-soft text-success" },
  { href: "/cq", title: "CQ Generator", icon: PenLine, ready: false, part: 3, text: "Create stimulus-based creative questions with optional model answers.", tone: "bg-warning-soft text-warning" },
];

export default async function WorkspacePage() {
  const me = await requireMe("/workspace");
  const [summary, profile] = await Promise.all([backendJson<Summary>("/api/dashboard/summary"), backendJson<Profile>("/api/profile")]);
  const firstName = me.user.name.split(" ")[0];

  const steps = [
    { done: true, label: "Create your account" },
    { done: me.user.emailVerified, label: "Verify your email address", href: "/settings/privacy" },
    { done: Boolean(profile.bio || (profile.displayName && profile.displayName !== me.user.name)), label: "Complete your profile", href: "/settings/profile" },
    { done: summary.providersConnected > 0, label: "Add an AI provider API key", href: "/settings/api-keys" },
    { done: summary.hasDefaultModel, label: "Choose your default model", href: "/settings/providers" },
    { done: summary.hasEmbeddingModel, label: "Choose an embedding model (needed to search documents)", href: "/settings/providers" },
    { done: summary.documents.ready > 0, label: "Upload and process your first document", href: "/documents" },
    { done: summary.questionsAsked > 0, label: "Ask your first question", href: "/chat" },
  ];

  return (
    <>
      <PageHeader title={`Welcome, ${firstName}`} description="Pick a study mode. Modules marked “Soon” are scheduled in the build plan and are not functional yet." />
      <VerifyEmailBanner verified={me.user.emailVerified} email={me.user.email} />
      <section aria-labelledby="modes" className="mb-8">
        <h2 id="modes" className="sr-only">Study modes</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {MODES.map(({ href, title, icon: Icon, ready, part, text, tone }) => (
            <Link key={href} href={href} className="group rounded-2xl border bg-card p-5 shadow-card transition hover:border-primary/40 focus-visible:outline-2">
              <div className="flex items-center justify-between">
                <span className={`inline-flex size-11 items-center justify-center rounded-2xl ${tone}`}><Icon className="size-5" aria-hidden /></span>
                {!ready && <Badge variant="outline" className="rounded-full text-[11px]">Soon · Part {part}</Badge>}
              </div>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary">{ready ? "Open" : "View plan"} <ArrowRight className="size-4 transition group-hover:translate-x-0.5" aria-hidden /></span>
            </Link>
          ))}
        </div>
      </section>

      <Card className="rounded-2xl shadow-card">
        <CardHeader>
          <CardTitle>Getting started</CardTitle>
          <CardDescription>Your real setup status. Each step completes when the feature is actually configured.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-3 py-3 text-sm">
                {s.done ? <CheckCircle2 className="size-5 text-success" aria-label="Done" /> : <Circle className="size-5 text-muted-foreground" aria-label="Not done" />}
                <span className={s.done ? "text-muted-foreground line-through" : "font-medium"}>{s.label}</span>
                {s.href && !s.done && <Link href={s.href} className="ml-auto text-primary hover:underline">Open</Link>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
