import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createPrismaClient, type Db } from "@/lib/db";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

/**
 * Lager en tom SQLite-database i en midlertidig mappe og kjører alle
 * migreringene i prisma/migrations på den. Hver testfil får sin egen database.
 */
export function createTestDb(): { db: Db; cleanup: () => Promise<void> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-nyheter-test-"));
  const file = path.join(dir, "test.db");

  const sqlite = new Database(file);
  const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of migrations) {
    sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"));
  }
  sqlite.close();

  const db = createPrismaClient(`file:${file}`);
  return {
    db,
    cleanup: async () => {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
