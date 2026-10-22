"use client";

import { Badge } from "@/components/ui/badge";
import { BAND_INFO, BAND_TONE_CLASS, type FeedbackBand } from "@/lib/bands";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

/** The band label as a chip. The band always comes from the server; this only renders it (text, not colour alone). */
export function BandChip({ band, className, ...rest }: { band: FeedbackBand | null; className?: string } & React.ComponentProps<"span">) {
  const t = useT();
  if (!band) return null;
  const info = BAND_INFO[band];
  return <Badge variant="outline" className={cn("rounded-full", BAND_TONE_CLASS[info.tone], className)} {...rest}>{t(info.label)}</Badge>;
}
