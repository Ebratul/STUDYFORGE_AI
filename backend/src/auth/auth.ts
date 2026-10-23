import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { db } from "../lib/db.js";
import { getEnv, isGoogleConfigured } from "../config/env.js";
import { isMailConfigured, sendMail } from "../lib/mail.js";
import { recordAudit } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { PASSWORD_MAX, PASSWORD_MIN } from "../lib/password-policy.js";
import { googleIdentityProblem, mapGoogleProfile } from "./google-profile.js";
import { createWelcomeNotification, notifyUsers } from "../modules/account/notifications.js";
import { queueDeleteUserVectors } from "../modules/vectors/store.js";

const SESSION_FRESH_SECONDS = 60 * 15;

/** Only the provider-issued credentials are dropped; the Account row itself (provider + provider account id) is what we need. */
const TOKEN_FIELDS_CLEARED = { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null } as const;

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

    // Google sign-in: authorization-code flow with PKCE and a signed `state` (library defaults). Redirect URI: <APP_URL>/api/auth/callback/google.
    // Scopes are exactly openid + email + profile (no Gmail, Drive or offline access). No client credentials in the browser.
    socialProviders: isGoogleConfigured(env)
      ? {
          google: {
            clientId: env.AUTH_GOOGLE_ID!,
            clientSecret: env.AUTH_GOOGLE_SECRET!,
            prompt: "select_account",
            // Profile fields are untrusted: normalised and allow-listed here. `emailVerified` is strictly Google's boolean.
            mapProfileToUser: (profile) => mapGoogleProfile(profile as unknown as Record<string, unknown>),
            // Sign-in never rewrites a returning user's name/picture: the app profile belongs to the user.
            overrideUserInfoOnSignIn: false,
          },
        }
      : {},

    account: {
      // Never persist Google's access/refresh/id tokens: no feature needs them (see databaseHooks.account below).
      updateAccountOnSignIn: false,
      accountLinking: {
        enabled: true,
        // A Google sign-in is never attached to a pre-existing account just because the e-mail matches. The owner links Google
        // explicitly from Settings while signed in (fresh session); until then Google sign-in is refused with `account_not_linked`.
        disableImplicitLinking: true,
        requireLocalEmailVerified: true,
        trustedProviders: [],
        // Linking requires the Google e-mail to equal the account e-mail.
        allowDifferentEmails: false,
        // The last remaining sign-in method can never be removed.
        allowUnlinkingAll: false,
      },
    },

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
      freshAge: SESSION_FRESH_SECONDS, // sensitive actions (e.g. delete account) need a recent sign-in
      // No signed cookie cache: revocation and suspension must take effect on the next request.
      cookieCache: { enabled: false },
    },

    user: {
      // Fail-closed gate for every Google identity (new user, link, returning sign-in): needs a stable subject and a verified e-mail.
      validateUserInfo: ({ source }) => {
        if (source.method !== "oauth" || source.oauth?.providerId !== "google") return;
        const problem = googleIdentityProblem(source.oauth.profile);
        if (problem) return { error: problem, errorDescription: "This Google account can't be used to sign in." };
      },
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
          const docs = await db.document.findMany({ where: { ownerId: user.id }, select: { id: true, storageKey: true } });
          if (docs.length) {
            await db.job.createMany({ data: docs.map((d) => ({ type: "delete-object", payload: { key: d.storageKey }, maxAttempts: 6 })) });
          }
          // Vectors outside PostgreSQL (dual / pinecone) do not cascade with the user. The job re-checks that the account is really gone.
          await queueDeleteUserVectors(db, user.id, docs.map((d) => d.id));
          // Deleting an owner dissolves their groups (and the group exams/results). Tell the other members first; the notifications
          // belong to the members, so they survive the cascade.
          const groups = await db.group.findMany({ where: { ownerId: user.id }, select: { id: true, title: true, members: { where: { userId: { not: user.id } }, select: { userId: true } } } });
          for (const g of groups)
            await notifyUsers(g.members.map((m) => m.userId), {
              type: "group.dissolved", title: "A group was removed", body: `The owner of “${g.title}” deleted their account, so the group and its exams were removed.`, dedupeKey: `group-dissolved:${g.id}`,
            });
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
        "/sign-in/social": { window: 60, max: 10 },
        "/callback/*": { window: 60, max: 20 },
        "/link-social": { window: 60, max: 5 },
        "/unlink-account": { window: 60, max: 5 },
      },
    },

    advanced: {
      cookiePrefix: "studyforge",
      useSecureCookies: secureCookies,
      // Origin + callback/redirect URL validation is ON everywhere. (Better Auth silently skips it when NODE_ENV=test, which would
      // leave the open-redirect and CSRF protections untested.)
      disableOriginCheck: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: secureCookies },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },

    databaseHooks: {
      account: {
        create: {
          before: (account) => Promise.resolve(account.providerId === "credential" ? undefined : { data: { ...account, ...TOKEN_FIELDS_CLEARED } }),
          after: async (account) => {
            if (account.providerId === "credential") return;
            await recordAudit({ actorId: account.userId, action: "auth.account_linked", targetType: "user", targetId: account.userId, metadata: { provider: account.providerId } });
          },
        },
        update: {
          before: (data) => Promise.resolve({ data: { ...data, ...Object.fromEntries(Object.keys(TOKEN_FIELDS_CLEARED).filter((k) => k in data).map((k) => [k, null])) } }),
        },
      },
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
              throw new APIError("FORBIDDEN", { code: "account_suspended", message: "This account is suspended." });
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
      before: createAuthMiddleware(async (ctx) => {
        // Connecting a new sign-in method is a sensitive action: a stolen, older session must not be able to attach an attacker's Google account.
        if (ctx.path !== "/link-social") return;
        const session = await getSessionFromCtx(ctx);
        if (!session) return; // the endpoint's own session middleware answers 401
        if (Date.now() - new Date(session.session.createdAt).getTime() >= SESSION_FRESH_SECONDS * 1000) {
          throw new APIError("FORBIDDEN", { code: "SESSION_NOT_FRESH", message: "Please sign in again to connect a sign-in method." });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const failed = ctx.context.returned instanceof APIError;
        if (failed) return;
        const userId = ctx.context.session?.user.id ?? ctx.context.newSession?.user.id;
        switch (ctx.path) {
          case "/change-password": {
            // Enforced here, not left to the client's `revokeOtherSessions` flag: a changed password ends every other session.
            const keep = ctx.context.newSession?.session.id ?? ctx.context.session?.session.id;
            if (userId && keep) await db.session.deleteMany({ where: { userId, id: { not: keep } } });
            await recordAudit({ actorId: userId, action: "auth.password_changed", targetType: "user", targetId: userId });
            break;
          }
          case "/reset-password":
            await recordAudit({ action: "auth.password_reset" });
            break;
          case "/request-password-reset":
            await recordAudit({ action: "auth.password_reset_requested" });
            break;
          case "/unlink-account":
            await recordAudit({ actorId: userId, action: "auth.account_unlinked", targetType: "user", targetId: userId });
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
