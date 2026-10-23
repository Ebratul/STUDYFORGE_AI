import { createHmac } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { db } from "./db.js";
import { getEnv } from "../config/env.js";
import { logger } from "./logger.js";
import { redact } from "./redact.js";

export type AuditAction =
  | "auth.sign_up"
  | "auth.sign_in"
  | "auth.sign_out"
  | "auth.password_changed"
  | "auth.password_reset"
  | "auth.password_reset_requested"
  | "auth.email_verified"
  | "account.profile_updated"
  | "account.preferences_updated"
  | "account.data_exported"
  | "account.deletion_requested"
  | "account.deleted"
  | "admin.role_granted"
  | "ai.credential_saved"
  | "ai.credential_rotated"
  | "ai.credential_deleted"
  | "ai.credential_tested"
  | "ai.preferences_updated"
  | "ai.connection_saved"
  | "document.uploaded"
  | "document.deleted"
  | "document.downloaded"
  | "conversation.deleted"
  | "questions.saved"
  | "questions.deleted"
  | "questions.bulk_deleted"
  | "questions.exported"
  | "generation.completed"
  | "exam.created"
  | "exam.published"
  | "exam.cancelled"
  | "exam.deleted"
  | "attempt.started"
  | "attempt.finalized"
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "group.member_joined"
  | "group.member_left"
  | "group.member_removed"
  | "group.role_changed"
  | "group.invite_created"
  | "group.invite_revoked"
  | "analysis.requested"
  | "admin.user_status_changed"
  | "admin.user_role_changed"
  | "admin.sessions_revoked"
  | "admin.job_retried";

/** One-way, keyed hash so audit rows can correlate abuse without storing raw IPs. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHmac("sha256", getEnv().BETTER_AUTH_SECRET).update(ip).digest("hex").slice(0, 32);
}

export async function recordAudit(input: {
  actorId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        // Callers must not pass secrets; redact() is a second line of defence.
        metadata: input.metadata ? (redact(input.metadata) as Prisma.InputJsonValue) : undefined,
        ipHash: hashIp(input.ip),
      },
    });
  } catch (err) {
    // Auditing must never break the user-facing operation.
    logger.error("audit.write_failed", { action: input.action, err });
  }
}
