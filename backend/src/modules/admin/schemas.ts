import { z } from "zod";
import { cleanText } from "../questions/text.js";

const id = z.string().min(1).max(64);

export const usersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  role: z.enum(["USER", "SUPPORT", "ADMIN"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const patchUserBody = z
  .strictObject({
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    role: z.enum(["USER", "SUPPORT", "ADMIN"]).optional(),
    reason: z.string().transform(cleanText).pipe(z.string().max(200)).optional(),
  })
  .refine((b) => b.status !== undefined || b.role !== undefined, { message: "Choose a status or a role to change." });

export const metricsQuery = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) });

export const auditQuery = z.object({
  action: z.string().trim().max(60).regex(/^[A-Za-z0-9_.:-]*$/).optional(),
  actor: id.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const idParam = id;
