import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getT } from "@/lib/i18n/server";

export default async function NotFound() {
  const t = await getT();
  return (
    <main id="main-content" className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm font-semibold text-primary">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">{t("Page not found")}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{t("The page doesn't exist, or you don't have access to it.")}</p>
      <Button asChild className="rounded-xl"><Link href="/">{t("Go home")}</Link></Button>
    </main>
  );
}
