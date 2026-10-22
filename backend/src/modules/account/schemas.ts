import { z } from "zod";

export const LOCALES = ["en", "bn"] as const;
export const THEMES = ["SYSTEM", "LIGHT", "DARK"] as const;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const profileSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80, "Use at most 80 characters."),
  displayName: z.string().trim().max(60, "Use at most 60 characters.").optional().default(""),
  bio: z.string().trim().max(280, "Use at most 280 characters.").optional().default(""),
  timezone: z.string().refine(isValidTimeZone, "Choose a valid time zone."),
});

export const preferencesSchema = z.object({
  theme: z.enum(THEMES),
  locale: z.enum(LOCALES),
  emailNotifications: z.boolean(),
  autoAiFeedback: z.boolean().optional(),
});
export type PreferencesInput = z.infer<typeof preferencesSchema>;
