import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Inter, Noto_Sans_Bengali } from "next/font/google";
import { Providers } from "@/components/providers";
import { LocaleProvider } from "@/lib/i18n/client";
import { getLocale, getT } from "@/lib/i18n/server";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const bengali = Noto_Sans_Bengali({ subsets: ["bengali"], variable: "--font-noto-bengali", display: "swap" });

export const metadata: Metadata = {
  title: { default: "StudyForge AI", template: "%s · StudyForge AI" },
  description: "An AI study workspace for document-grounded learning, practice questions and timed exams.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f3fb" },
    { media: "(prefers-color-scheme: dark)", color: "#16131f" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The CSP nonce is generated per request in src/proxy.ts and needed by next-themes' inline script.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const locale = await getLocale();
  const t = await getT();
  return (
    <html lang={locale} dir="ltr" suppressHydrationWarning className={`${sans.variable} ${bengali.variable}`}>
      <body className="min-h-dvh font-sans">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          {t("Skip to content")}
        </a>
        <LocaleProvider locale={locale}>
          <Providers nonce={nonce}>{children}</Providers>
        </LocaleProvider>
      </body>
    </html>
  );
}
