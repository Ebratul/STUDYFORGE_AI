import Link from "next/link";
import { ArrowRight, BookOpenCheck, FileText, GraduationCap, KeyRound, ListChecks, MessagesSquare, PenLine, ShieldCheck, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const FEATURES = [
  { icon: MessagesSquare, title: "Grounded conversation", text: "Ask questions in general mode, or lock answers to your own documents with page-level sources — no silent guessing.", part: 2 },
  { icon: ListChecks, title: "MCQ generation", text: "Validated multiple-choice questions with explanations and short notes, ready to edit and save.", part: 3 },
  { icon: PenLine, title: "CQ generation", text: "Stimulus-based creative questions, including a Bangla CQ preset, with or without model answers.", part: 3 },
  { icon: GraduationCap, title: "Timed exams", text: "Server-timed exams with autosave and deterministic scoring you can trust.", part: 4 },
  { icon: Users, title: "Study groups", text: "Invite classmates, share an identical exam, and compare results on a leaderboard.", part: 4 },
  { icon: KeyRound, title: "Bring your own key", text: "Use OpenAI, OpenRouter, Groq or Gemini with keys stored encrypted on the server.", part: 2 },
];

const STEPS = [
  { icon: FileText, title: "Add your material", text: "Upload notes, chapters or PDFs — or just name a topic." },
  { icon: BookOpenCheck, title: "Practise", text: "Generate questions and chat with sources you can check." },
  { icon: GraduationCap, title: "Sit an exam", text: "Take a timed exam alone or with your group." },
  { icon: ShieldCheck, title: "Review & improve", text: "See verified scores, explanations and where to revise next." },
];

export default function LandingPage() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6 sm:py-24">
          <Badge variant="secondary" className="rounded-full px-3 py-1">Foundation preview · under active development</Badge>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Study from <span className="text-primary">your own material</span>, then prove what you know.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
            StudyForge is an AI study workspace for document-grounded answers, practice questions and timed exams — for students and study groups, in English and Bangla.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="h-11 rounded-xl px-6"><Link href="/register">Create free account <ArrowRight aria-hidden /></Link></Button>
            <Button asChild size="lg" variant="outline" className="h-11 rounded-xl px-6"><Link href="/login">Sign in</Link></Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">Accounts, profiles and security are live today. Study modules are rolling out in stages.</p>
        </div>
      </section>

      <section id="features" className="border-y bg-card/60">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">Everything for focused study</h2>
          <p className="mt-2 max-w-2xl text-muted-foreground">Each module is being built and tested one part at a time. Items below show their planned release stage.</p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, text, part }) => (
              <li key={title} className="rounded-2xl border bg-card p-5 shadow-card">
                <div className="flex items-center justify-between">
                  <span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground"><Icon className="size-5" aria-hidden /></span>
                  <Badge variant="outline" className="rounded-full text-[11px]">Part {part}</Badge>
                </div>
                <h3 className="mt-4 font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
        <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <li key={title} className="rounded-2xl border bg-card p-5">
              <span className="inline-flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{i + 1}</span>
              <h3 className="mt-3 flex items-center gap-2 font-semibold"><Icon className="size-4 text-primary" aria-hidden /> {title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="rounded-2xl bg-primary px-6 py-10 text-center text-primary-foreground sm:px-12">
          <h2 className="text-2xl font-semibold tracking-tight">Ready to start?</h2>
          <p className="mx-auto mt-2 max-w-xl text-primary-foreground/90">Create your account now and be first in line as each module goes live.</p>
          <Button asChild size="lg" variant="secondary" className="mt-6 h-11 rounded-xl px-6"><Link href="/register">Get started</Link></Button>
        </div>
      </section>
    </>
  );
}
