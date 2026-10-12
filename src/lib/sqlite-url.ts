import path from "node:path";

/**
 * Gjør en relativ SQLite-URL (file:./prisma/dev.db) absolutt, regnet fra
 * prosjektroten. Prisma-CLI og runtime-adapteren tolker ellers relative stier
 * ulikt, og man kan ende opp med to forskjellige databasefiler.
 */
export function resolveSqliteUrl(url: string | undefined, cwd: string = process.cwd()): string {
  if (!url) {
    throw new Error("DATABASE_URL mangler. Kopier .env.example til .env.");
  }
  if (!url.startsWith("file:")) {
    throw new Error(`DATABASE_URL må starte med «file:» for SQLite, fikk «${url}».`);
  }
  const filePath = url.slice("file:".length);
  if (filePath === ":memory:" || path.isAbsolute(filePath)) {
    return url;
  }
  return `file:${path.resolve(cwd, filePath)}`;
}
