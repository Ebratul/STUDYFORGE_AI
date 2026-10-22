import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Next.js convention: .env.local overrides .env. Neither is committed.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // DIRECT_URL (non-pooled) is preferred for migrations, e.g. Neon's direct endpoint.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || "",
  },
});
