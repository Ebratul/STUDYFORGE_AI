import { redirect } from "next/navigation";
import { BookOpenCheck, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { getMe } from "@/lib/server/backend";
import { getT } from "@/lib/i18n/server";
import { msg } from "@/lib/i18n/translate";
import { LanguageSwitcher } from "@/components/app-shell/language-switcher";

const POINTS = [
  { icon: Sparkles, text: msg("Document-grounded answers with source references") },
  { icon: BookOpenCheck, text: msg("MCQ and CQ practice with validated answer keys") },
  { icon: Users, text: msg("Timed exams and study-group leaderboards") },
  { icon: ShieldCheck, text: msg("Your documents and API keys stay private to you") },
];

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  // UX convenience only; the app routes enforce authentication themselves.
  if (await getMe()) redirect("/workspace");
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden flex-col justify-between bg-brand-panel p-10 text-brand-panel-foreground lg:flex">
        <Logo href="/" inverted />
        <div>
          <h2 className="max-w-md text-3xl font-semibold leading-tight tracking-tight">{t("Study smarter from your own material.")}</h2>
          <ul className="mt-8 space-y-4">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-white/90">
                <span className="inline-flex size-9 items-center justify-center rounded-xl bg-white/15"><Icon className="size-4" aria-hidden /></span>
                {t(text)}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-white/80">© StudyForge AI</p>
      </aside>
      <main id="main-content" tabIndex={-1} className="flex items-center justify-center bg-background px-4 py-10 outline-none sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center justify-between lg:hidden"><Logo href="/" /><LanguageSwitcher signedIn={false} /></div>
          <div className="mb-4 hidden justify-end lg:flex"><LanguageSwitcher signedIn={false} /></div>
          <div className="rounded-2xl border bg-card p-6 shadow-card sm:p-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
