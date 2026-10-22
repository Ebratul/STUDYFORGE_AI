"use client";

import Link from "next/link";
import { BookOpenCheck, CalendarClock, Users } from "lucide-react";
import { ROLE_LABEL, type GroupRole } from "@/lib/groups";
import type { GroupBrief, SavedContent } from "@/lib/analytics";
import { useFormat, useT } from "@/lib/i18n/client";

export function SavedContentCard({ saved }: { saved: SavedContent }) {
  const t = useT();
  const empty = saved.collections === 0 && saved.mcqQuestions === 0 && saved.cqQuestions === 0;
  if (empty) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="saved-empty">
        <BookOpenCheck className="size-5 shrink-0" aria-hidden />
        <span>{t("Nothing saved yet. Generate questions and save them to build practice sets.")}</span>
        <Link href="/mcq" className="font-medium text-primary underline">{t("MCQ generator")}</Link>
      </div>
    );
  }
  const cells = [
    { label: t("Collections"), value: saved.collections }, { label: t("MCQs"), value: saved.mcqQuestions }, { label: t("CQs"), value: saved.cqQuestions }, { label: t("With study notes"), value: saved.questionsWithNotes },
  ];
  return (
    <div data-testid="saved-content">
      <dl className="grid grid-cols-2 gap-2">
        {cells.map((c) => <div key={c.label} className="rounded-xl border bg-background p-3 text-center"><dt className="text-xs text-muted-foreground">{c.label}</dt><dd className="mt-0.5 text-xl font-semibold tabular-nums">{c.value}</dd></div>)}
      </dl>
      {saved.recentCollections.length > 0 && (
        <ul className="mt-3 divide-y text-sm" aria-label={t("Recent collections")}>
          {saved.recentCollections.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2"><Link href={`/question-bank?collection=${encodeURIComponent(c.id)}`} className="min-w-0 truncate font-medium hover:underline">{c.title}</Link><span className="shrink-0 text-xs text-muted-foreground">{t("{count, plural, one {# question} other {# questions}}", { count: c.questionCount })}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GroupsCard({ groups }: { groups: GroupBrief[] }) {
  const t = useT();
  const format = useFormat();
  if (groups.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="groups-empty">
        <Users className="size-5 shrink-0" aria-hidden /> <span>{t("You're not in a group yet.")}</span> <Link href="/groups" className="font-medium text-primary underline">{t("Create or join one")}</Link>
      </div>
    );
  }
  return (
    <ul className="divide-y text-sm" aria-label={t("Your groups")} data-testid="groups-list">
      {groups.map((g) => (
        <li key={g.id} className="py-2.5">
          <div className="flex items-center justify-between gap-3"><Link href={`/groups/${g.id}`} className="min-w-0 truncate font-medium hover:underline">{g.title}</Link><span className="shrink-0 text-xs text-muted-foreground">{ROLE_LABEL[g.role as GroupRole] ? t(ROLE_LABEL[g.role as GroupRole]) : g.role}</span></div>
          {g.nextExam && (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarClock className="size-3.5 shrink-0" aria-hidden /><Link href={`/exams/${g.nextExam.examId}`} className="truncate hover:underline">{g.nextExam.title}</Link>
              · {g.nextExam.opensAt ? t("opens {when}", { when: format.dateTime(g.nextExam.opensAt) }) : g.nextExam.closesAt ? t("closes {when}", { when: format.dateTime(g.nextExam.closesAt) }) : t("open now")}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
