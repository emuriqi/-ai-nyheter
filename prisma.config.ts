import "dotenv/config";
import { defineConfig } from "prisma/config";
import { resolveSqliteUrl } from "./src/lib/sqlite-url";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // `prisma generate` trenger ingen database, så URL-en er valgfri her.
  datasource: {
    url: process.env.DATABASE_URL ? resolveSqliteUrl(process.env.DATABASE_URL) : undefined,
  },
});
