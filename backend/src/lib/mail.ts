import nodemailer, { type Transporter } from "nodemailer";
import { getEnv } from "../config/env.js";
import { logger } from "./logger.js";

export function isMailConfigured(): boolean {
  return Boolean(getEnv().SMTP_URL);
}

let transport: Transporter | undefined;

export async function sendMail(input: { to: string; subject: string; text: string; html?: string }) {
  const env = getEnv();
  if (!env.SMTP_URL) {
    // No fallback that prints links/tokens: an unconfigured mailer is an explicit, visible state.
    logger.warn("mail.not_configured", { subject: input.subject });
    return { sent: false as const };
  }
  transport ??= nodemailer.createTransport(env.SMTP_URL);
  await transport.sendMail({ from: env.EMAIL_FROM, ...input });
  return { sent: true as const };
}
