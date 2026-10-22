import { db } from "../../lib/db.js";
import type { SessionUser } from "../../auth/types.js";
import type { PreferencesInput } from "./schemas.js";
import { profileSchema } from "./schemas.js";
import { recordAudit } from "../../lib/audit.js";
import type { z } from "zod";

export async function getProfileBundle(user: SessionUser) {
  const [profile, preference] = await Promise.all([
    db.userProfile.findUnique({ where: { userId: user.id } }),
    db.userPreference.findUnique({ where: { userId: user.id } }),
  ]);
  return { profile, preference };
}

/** The target is always `user.id` from the session; there is no id parameter to tamper with. */
export async function updateProfile(user: SessionUser, input: z.output<typeof profileSchema>) {
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { name: input.name } }),
    db.userProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, displayName: input.displayName || null, bio: input.bio || null, timezone: input.timezone },
      update: { displayName: input.displayName || null, bio: input.bio || null, timezone: input.timezone },
    }),
  ]);
  await recordAudit({ actorId: user.id, action: "account.profile_updated", targetType: "user", targetId: user.id });
}

export async function updatePreferences(user: SessionUser, input: PreferencesInput) {
  await db.userPreference.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...input },
    update: input,
  });
  await recordAudit({ actorId: user.id, action: "account.preferences_updated", targetType: "user", targetId: user.id });
}
