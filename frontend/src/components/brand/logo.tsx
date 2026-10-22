"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export function LogoMark({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-9 items-center justify-center rounded-xl shadow-sm", inverted ? "bg-white/15 text-white" : "bg-primary text-primary-foreground", className)}
    >
      <Sparkles className="size-4.5" />
    </span>
  );
}

export function Logo({ href = "/", className, showWordmark = true, inverted = false }: { href?: string; className?: string; showWordmark?: boolean; inverted?: boolean }) {
  const t = useT();
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2.5 rounded-lg font-semibold tracking-tight", className)} aria-label={t("StudyForge AI home")}>
      <LogoMark inverted={inverted} />
      {showWordmark && <span className={cn("text-[15px]", inverted && "text-white")}>StudyForge <span className={inverted ? "text-violet-200" : "text-primary"}>AI</span></span>}
    </Link>
  );
}
