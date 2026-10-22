
export type NavIconName =
  | "Sparkles" | "LayoutDashboard" | "MessagesSquare" | "ListChecks" | "PenLine" | "FileText" | "BookOpenCheck"
  | "GraduationCap" | "Users" | "Bell" | "UserRound" | "ShieldCheck" | "SlidersHorizontal" | "KeyRound" | "ShieldAlert";

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
    label: "Main",
    items: [
      { href: "/workspace", label: "Workspace", icon: "Sparkles", status: "ready", keywords: "home start" },
      { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard", status: "ready", keywords: "overview progress" },
      { href: "/chat", label: "Conversation", icon: "MessagesSquare", status: "ready", keywords: "chat ai ask" },
      { href: "/mcq", label: "MCQ Generator", icon: "ListChecks", status: "planned", part: 3, keywords: "multiple choice questions" },
      { href: "/cq", label: "CQ Generator", icon: "PenLine", status: "planned", part: 3, keywords: "creative questions" },
    ],
  },
  {
    id: "library",
    label: "Library & Practice",
    items: [
      { href: "/documents", label: "Documents", icon: "FileText", status: "ready", keywords: "upload pdf files" },
      { href: "/question-bank", label: "Question Bank", icon: "BookOpenCheck", status: "planned", part: 3, keywords: "saved questions collections" },
      { href: "/exams", label: "Exams", icon: "GraduationCap", status: "planned", part: 4, keywords: "history timed tests results" },
      { href: "/groups", label: "Groups", icon: "Users", status: "planned", part: 5, keywords: "study group leaderboard" },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      { href: "/notifications", label: "Notifications", icon: "Bell", status: "ready", keywords: "alerts inbox" },
      { href: "/settings/profile", label: "Profile", icon: "UserRound", status: "ready", keywords: "name bio timezone" },
      { href: "/settings/privacy", label: "Privacy & account", icon: "ShieldCheck", status: "ready", keywords: "password delete export sessions security" },
      { href: "/settings/providers", label: "AI providers", icon: "SlidersHorizontal", status: "ready", keywords: "models openai openrouter groq" },
      { href: "/settings/api-keys", label: "API keys", icon: "KeyRound", status: "ready", keywords: "byok credentials" },
      { href: "/admin", label: "Admin", icon: "ShieldAlert", status: "ready", adminOnly: true, keywords: "operations" },
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

