"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

/** Applies the theme saved on the account once per browser session (device toggle still wins afterwards). */
export function ThemeSync({ preference }: { preference: "SYSTEM" | "LIGHT" | "DARK" }) {
  const { setTheme } = useTheme();
  useEffect(() => {
    try {
      if (sessionStorage.getItem("sf-theme-synced")) return;
      sessionStorage.setItem("sf-theme-synced", "1");
    } catch {
      return;
    }
    setTheme(preference.toLowerCase());
  }, [preference, setTheme]);
  return null;
}
