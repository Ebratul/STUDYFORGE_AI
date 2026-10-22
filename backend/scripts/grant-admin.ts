/**
 * Grants the ADMIN role to an existing user. Run deliberately from a trusted shell:
 *   pnpm admin:grant someone@example.com
 * There is intentionally no UI or API for self-promotion.
 */
import { config } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error("Usage: pnpm admin:grant <email>");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const user = await db.user.findUnique({ where: { email }, select: { id: true, role: true } });
    if (!user) throw new Error("No user with that email.");
    if (user.role === "ADMIN") return console.log("Already an admin.");
    await db.$transaction([
      db.user.update({ where: { id: user.id }, data: { role: "ADMIN" } }),
      db.auditEvent.create({ data: { actorId: null, action: "admin.role_granted", targetType: "user", targetId: user.id, metadata: { via: "cli" } } }),
    ]);
    console.log("Role granted. Existing sessions pick it up on their next request.");
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
