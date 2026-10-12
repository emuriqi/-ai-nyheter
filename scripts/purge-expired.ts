import "dotenv/config";
import { siteConfig } from "@/lib/config";
import { createPrismaClient } from "@/lib/db";
import { runRetentionJob } from "@/lib/retention";

// Sletter kildetekst som har passert sletteperioden i config/site.config.ts.
// Kjøres med `npm run purge`, og senere automatisk etter hver innhenting.
const db = createPrismaClient();
try {
  const stats = await runRetentionJob(db, {
    trigger: "script",
    sourceTextDays: siteConfig.retention.sourceTextDays,
    jobRunDays: siteConfig.retention.jobRunDays,
  });
  console.log(
    `Sletting ferdig: kildetekst fjernet fra ${stats.purgedSourceItems} elementer, ${stats.deletedJobRuns} gamle jobblogger slettet.`,
  );
} finally {
  await db.$disconnect();
}
