import "dotenv/config";
import { siteConfig } from "@/lib/config";
import { createPrismaClient } from "@/lib/db";
import { syncSourcesFromConfig } from "@/lib/sources/sync";

// Synkroniserer kildene fra config/site.config.ts til databasen.
// Kjøres med `npm run db:seed`, og av `npm run db:reset` etter at databasen er nullstilt.
const db = createPrismaClient();
try {
  const result = await syncSourcesFromConfig(db, siteConfig.sources);
  console.log(
    `Kilder synkronisert: ${result.created} nye, ${result.updated} oppdatert, ${result.paused} satt på pause.`,
  );
} finally {
  await db.$disconnect();
}
