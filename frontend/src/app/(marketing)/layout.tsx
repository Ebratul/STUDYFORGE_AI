import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { getMe } from "@/lib/server/backend";

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const user = await getMe();
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav aria-label="Marketing" className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <Link href="/#features" className="hover:text-foreground">Features</Link>
            <Link href="/#how-it-works" className="hover:text-foreground">How it works</Link>
            <Link href="/help" className="hover:text-foreground">Help</Link>
          </nav>
          <div className="flex items-center gap-2">
            {user ? (
              <Button asChild className="rounded-xl"><Link href="/workspace">Open workspace</Link></Button>
            ) : (
              <>
                <Button asChild variant="ghost" className="rounded-xl"><Link href="/login">Sign in</Link></Button>
                <Button asChild className="rounded-xl"><Link href="/register">Get started</Link></Button>
              </>
            )}
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">{children}</main>
      <footer className="border-t bg-card">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <p>© StudyForge AI</p>
          <nav aria-label="Legal" className="flex gap-5">
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
            <Link href="/help" className="hover:text-foreground">Help</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
