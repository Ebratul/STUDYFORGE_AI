import { z } from "zod";
import { getEnv } from "../../config/env.js";
import { cleanText } from "../questions/text.js";

const reqStr = (max: number, what: string) =>
  z
    .string({ error: `Enter ${what}.` })
    .transform(cleanText)
    .pipe(z.string().min(1, `Enter ${what}.`).max(max, `Use at most ${max} characters.`));

const optStr = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => (v == null ? null : cleanText(v) || null))
    .pipe(z.string().max(max, `Use at most ${max} characters.`).nullable());

export const GROUP_FIELDS = { title: 80, description: 500 } as const;
export const idSchema = z.string().min(1).max(64);

const capacity = () => {
  const env = getEnv();
  return z.number({ error: "Enter a number." }).int().min(2, "A group needs room for at least 2 members.").max(env.GROUP_MAX_CAPACITY, `Capacity can be at most ${env.GROUP_MAX_CAPACITY}.`);
};

export const createGroupSchema = () => z.strictObject({ title: reqStr(GROUP_FIELDS.title, "a group name"), description: optStr(GROUP_FIELDS.description), capacity: capacity().optional() });
export const updateGroupSchema = () => z.strictObject({ title: reqStr(GROUP_FIELDS.title, "a group name").optional(), description: optStr(GROUP_FIELDS.description).optional(), capacity: capacity().optional() });
export const deleteGroupSchema = z.strictObject({ confirmTitle: z.string().max(200) });
export const roleSchema = z.strictObject({ role: z.enum(["ADMIN", "MEMBER"]) });
export const meSchema = z.strictObject({ showNameOnLeaderboard: z.boolean() });

export const inviteSchema = () => {
  const env = getEnv();
  return z.strictObject({
    expiresInHours: z.number().int().min(1).max(env.INVITE_MAX_TTL_HOURS, `Invitations can last at most ${env.INVITE_MAX_TTL_HOURS} hours.`).optional(),
    maxUses: z.number().int().min(1).max(env.INVITE_MAX_USES, `An invitation can be used at most ${env.INVITE_MAX_USES} times.`).optional(),
    email: z.string().trim().toLowerCase().email("Enter a valid e-mail address.").max(254).optional(),
  });
};

export const joinSchema = z.strictObject({ code: z.string().min(1).max(80) });

export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
