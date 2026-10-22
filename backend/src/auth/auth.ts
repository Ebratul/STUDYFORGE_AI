import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { db } from "../lib/db.js";
import { getEnv } from "../config/env.js";
import { isMailConfigured, sendMail } from "../lib/mail.js";
import { recordAudit } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { PASSWORD_MAX, PASSWORD_MIN } from "../lib/password-policy.js";
import { createWelcomeNotification } from "../modules/account/notifications.js";

function createAuth() {
  const env = getEnv();
  // Secure cookies whenever the app is served over https (always the case in real deployments).
  const secureCookies = env.APP_URL.startsWith("https://");
  return betterAuth({
    appName: "StudyForge AI",
    // Browsers only ever see the frontend origin (it proxies /api/* here), so links in emails and
    // redirects must use it.
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: prismaAdapter(db, { provider: "postgresql" }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      requireEmailVerification: env.AUTH_REQUIRE_EMAIL_VERIFICATION,
      resetPasswordTokenExpiresIn: 60 * 60,
      // Sessions on every device are invalidated when a password is reset.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        // Not awaited: constant response time prevents account enumeration via timing.
        void sendMail({
          to: user.email,
          subject: "Reset your StudyForge password",
          text: `Hi ${user.name},\n\nUse this link to choose a new password (valid for 1 hour):\n${url}\n\nIf you didn't ask for this, you can ignore this email.`,
        }).catch((err) => logger.error("mail.reset_failed", { err }));
      },
    },

    emailVerification: {
      sendOnSignUp: isMailConfigured(),
      sendOnSignIn: env.AUTH_REQUIRE_EMAIL_VERIFICATION,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        void sendMail({
          to: user.email,
          subject: "Verify your StudyForge email",
          text: `Hi ${user.name},\n\nConfirm your email address:\n${url}\n\nThis link expires in 24 hours.`,
        }).catch((err) => logger.error("mail.verify_failed", { err }));
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15, // sensitive actions (e.g. delete account) need a recent sign-in
      // No signed cookie cache: revocation and suspension must take effect on the next request.
      cookieCache: { enabled: false },
    },

    user: {
      additionalFields: {
        // `input: false` => clients can never set these at sign-up or via update-user.
        role: { type: "string", defaultValue: "USER", input: false },
        status: { type: "string", defaultValue: "ACTIVE", input: false },
      },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          // DB rows (documents, chunks, conversations, credentials…) cascade with the user; the stored files do not,
          // so queue their removal (retried by the worker) before the rows disappear.
          const docs = await db.document.findMany({ where: { ownerId: user.id }, select: { storageKey: true } });
          if (docs.length) {
            await db.job.createMany({ data: docs.map((d) => ({ type: "delete-object", payload: { key: d.storageKey }, maxAttempts: 6 })) });
          }
          await recordAudit({ actorId: user.id, action: "account.deletion_requested", targetType: "user", targetId: user.id });
        },
        afterDelete: async (user) => {
          await recordAudit({ action: "account.deleted", targetType: "user", targetId: user.id });
        },
      },
    },

    rateLimit: {
      enabled: true, // also in development so the behaviour is tested, not assumed
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 8 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
        "/delete-user": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
      },
    },

    advanced: {
      cookiePrefix: "studyforge",
      useSecureCookies: secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: secureCookies },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },

    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await db.userProfile.create({ data: { userId: user.id, displayName: user.name } });
            await db.userPreference.create({ data: { userId: user.id } });
            await createWelcomeNotification(user.id, user.name);
            await recordAudit({ actorId: user.id, action: "auth.sign_up", targetType: "user", targetId: user.id });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await db.user.findUnique({ where: { id: session.userId }, select: { status: true } });
            if (user?.status === "SUSPENDED") {
              throw new APIError("FORBIDDEN", { message: "This account is suspended." });
            }
            return { data: session };
          },
          after: async (session) => {
            await recordAudit({
              actorId: session.userId,
              action: "auth.sign_in",
              targetType: "session",
              ip: session.ipAddress,
            });
          },
        },
      },
    },

    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const failed = ctx.context.returned instanceof APIError;
        if (failed) return;
        const userId = ctx.context.session?.user.id ?? ctx.context.newSession?.user.id;
        switch (ctx.path) {
          case "/change-password":
            await recordAudit({ actorId: userId, action: "auth.password_changed", targetType: "user", targetId: userId });
            break;
          case "/reset-password":
            await recordAudit({ action: "auth.password_reset" });
            break;
          case "/request-password-reset":
            await recordAudit({ action: "auth.password_reset_requested" });
            break;
          case "/sign-out":
            await recordAudit({ actorId: userId, action: "auth.sign_out" });
            break;
          case "/verify-email":
            await recordAudit({ actorId: userId, action: "auth.email_verified" });
            break;
        }
      }),
    },

  });
}

type AuthInstance = ReturnType<typeof createAuth>;
const globalForAuth = globalThis as unknown as { __studyforgeAuth?: AuthInstance };

export function getAuth(): AuthInstance {
  globalForAuth.__studyforgeAuth ??= createAuth();
  return globalForAuth.__studyforgeAuth;
}
