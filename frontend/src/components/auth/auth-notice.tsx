"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AUTH_NOTICE_PARAM } from "@/lib/google-auth";
import { useT } from "@/lib/i18n/client";

/**
 * Confirms a completed Google sign-in once ("success" state), then removes the one-shot parameter from the address bar.
 * Only the two known values are acted on; anything else is ignored.
 */
export function AuthNotice() {
  const t = useT();
  const params = useSearchParams();
  const notice = params.get(AUTH_NOTICE_PARAM);

  useEffect(() => {
    if (notice !== "google" && notice !== "google-new") return;
    toast.success(notice === "google-new" ? t("Welcome to StudyForge! Your account was created with Google.") : t("Signed in with Google."));
    const url = new URL(window.location.href);
    url.searchParams.delete(AUTH_NOTICE_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [notice, t]);

  return null;
}
