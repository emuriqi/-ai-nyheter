import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { resolveSqliteUrl } from "./sqlite-url";

export type Db = PrismaClient;

/** Lager en ny klient. Brukes av scripts og tester som trenger egen database. */
export function createPrismaClient(databaseUrl: string | undefined = process.env.DATABASE_URL): Db {
  const adapter = new PrismaBetterSqlite3({ url: resolveSqliteUrl(databaseUrl) });
  return new PrismaClient({ adapter });
}

// Gjenbruk én klient i utvikling, der Next laster moduler på nytt ved endringer.
const globalForPrisma = globalThis as unknown as { prisma?: Db };

/** Delt klient for appen. Opprettes først når den brukes. */
export function getDb(): Db {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }
  return globalForPrisma.prisma;
}
