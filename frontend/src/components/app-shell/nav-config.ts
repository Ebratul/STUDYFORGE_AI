import { msg } from "@/lib/i18n/translate";

export type NavIconName =
  | "Sparkles" | "LayoutDashboard" | "MessagesSquare" | "ListChecks" | "PenLine" | "FileText" | "BookOpenCheck"
  | "GraduationCap" | "NotebookPen" | "Users" | "Bell" | "UserRound" | "ShieldCheck" | "SlidersHorizontal" | "KeyRound" | "ShieldAlert";

export type NavStatus = "ready" | "planned";
export type NavItem = {
  href: string;
  label: string;
  /** Icon key resolved to a component in nav-icons.ts (components can't cross the server/client boundary). */
  icon: NavIconName;
  status: NavStatus;
  /** Which build part delivers it (shown for planned items). */
  part?: number;
  adminOnly?: boolean;
  keywords?: string;
};
export type NavSection = { id: string; label: string; items: NavItem[] };

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "main",
    label: msg("Main"),
    items: [
      { href: "/workspace", label: msg("Workspace"), icon: "Sparkles", status: "ready", keywords: "home start" },
      { href: "/dashboard", label: msg("Dashboard"), icon: "LayoutDashboard", status: "ready", keywords: "overview progress" },
      { href: "/study-plan", label: msg("Study plan"), icon: "NotebookPen", status: "ready", keywords: "improvement plan weak topics revision recommendations" },
      { href: "/chat", label: msg("Conversation"), icon: "MessagesSquare", status: "ready", keywords: "chat ai ask" },
      { href: "/mcq", label: msg("MCQ Generator"), icon: "ListChecks", status: "ready", keywords: "multiple choice questions" },
      { href: "/cq", label: msg("CQ Generator"), icon: "PenLine", status: "ready", keywords: "creative questions" },
    ],
  },
  {
    id: "library",
    label: msg("Library & Practice"),
    items: [
      { href: "/documents", label: msg("Documents"), icon: "FileText", status: "ready", keywords: "upload pdf files" },
      { href: "/question-bank", label: msg("Question Bank"), icon: "BookOpenCheck", status: "ready", keywords: "saved questions collections" },
      { href: "/exams", label: msg("Exams"), icon: "GraduationCap", status: "ready", keywords: "history timed tests results" },
      { href: "/groups", label: msg("Groups"), icon: "Users", status: "ready", keywords: "study group leaderboard invite" },
    ],
  },
  {
    id: "system",
    label: msg("System"),
    items: [
      { href: "/notifications", label: msg("Notifications"), icon: "Bell", status: "ready", keywords: "alerts inbox" },
      { href: "/settings/profile", label: msg("Profile"), icon: "UserRound", status: "ready", keywords: "name bio timezone" },
      { href: "/settings/privacy", label: msg("Privacy & account"), icon: "ShieldCheck", status: "ready", keywords: "password delete export sessions security" },
      { href: "/settings/providers", label: msg("AI connection"), icon: "KeyRound", status: "ready", keywords: "api key model models openrouter openai groq embedding byok credentials providers" },
      { href: "/admin", label: msg("Admin"), icon: "ShieldAlert", status: "ready", adminOnly: true, keywords: "operations" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);

export function sectionsFor(isAdmin: boolean): NavSection[] {
  return NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => !i.adminOnly || isAdmin) })).filter((s) => s.items.length);
}

export function findNavItem(pathname: string): NavItem | undefined {
  return [...ALL_NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
}

