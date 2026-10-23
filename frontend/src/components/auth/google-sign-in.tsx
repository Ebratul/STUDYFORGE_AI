"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Info, Loader2, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { googleErrorCallback, googleErrorFor, withAuthNotice } from "@/lib/google-auth";
import { safeNextPath } from "@/lib/safe-next";
import { useT } from "@/lib/i18n/client";
import { GoogleIcon } from "./google-icon";

type Mode = "login" | "register";

/** Presentational: the "Continue with Google" button and the "or" divider. Also used as the Suspense fallback. */
export function GoogleButtonView({ busy = false, disabled = false, onClick }: { busy?: boolean; disabled?: boolean; onClick?: () => void }) {
  const t = useT();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-10 w-full rounded-xl bg-card font-medium"
        onClick={onClick}
        disabled={disabled || busy}
        aria-busy={busy}
        data-testid="google-sign-in"
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <GoogleIcon />}
        {busy ? t("Connecting to Google…") : t("Continue with Google")}
      </Button>
      <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        <span>{t("or continue with email")}</span>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
    </>
  );
}

/**
 * Starts the Google OAuth flow. The browser is sent to Google by the server's authorization URL (code flow + PKCE + state);
 * no client id, secret or token is ever handled here. Only a validated same-site path is passed as the post-login target.
 */
export function GoogleSignIn({ mode, enabled }: { mode: Mode; enabled: boolean }) {
  const t = useT();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Coming back with the browser's Back button restores this page from the bfcache with the spinner still on.
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  if (!enabled) return null;

  const fromUrl = googleErrorFor(params.get("error"));
  const shown = startError ? { message: startError, tone: "error" as const } : fromUrl ? { message: t(fromUrl.message), tone: fromUrl.tone } : null;

  async function start() {
    setBusy(true);
    setStartError(null);
    const next = safeNextPath(params.get("next"));
    try {
      const { error } = await authClient.signIn.social({
        provider: "google",
        callbackURL: withAuthNotice(next, "google"),
        newUserCallbackURL: withAuthNotice(next, "google-new"),
        errorCallbackURL: googleErrorCallback(mode, params.get("next")),
      });
      if (error) {
        setBusy(false);
        setStartError(error.status === 429 ? t("Too many attempts. Please wait a minute and try again.") : t("We couldn't start Google sign-in. Please try again."));
      }
      // No error: the browser is navigating to Google, so the busy state stays until the page unloads.
    } catch {
      setBusy(false);
      setStartError(t("We couldn't start Google sign-in. Please try again."));
    }
  }

  return (
    <div>
      {shown && (
        <Alert variant={shown.tone === "error" ? "destructive" : "default"} role={shown.tone === "error" ? "alert" : "status"} className="mb-4">
          {shown.tone === "error" ? <TriangleAlert aria-hidden /> : <Info aria-hidden />}
          <AlertDescription>{shown.message}</AlertDescription>
        </Alert>
      )}
      <GoogleButtonView busy={busy} onClick={start} />
      <p className="sr-only" role="status" aria-live="polite">{busy ? t("Redirecting to Google…") : ""}</p>
    </div>
  );
}
