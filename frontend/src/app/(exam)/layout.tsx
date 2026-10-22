import { ThemeSync } from "@/components/app-shell/theme-sync";
import { requireMe } from "@/lib/server/backend";

/**
 * Focused layout for taking an exam: no sidebar, no navigation, nothing to distract.
 * Lives outside the (app) group on purpose so the normal app shell is not applied.
 */
export default async function ExamLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe();
  return (
    <div className="min-h-dvh bg-exam-canvas text-foreground">
      <ThemeSync preference={me.preference.theme} />
      {children}
    </div>
  );
}
