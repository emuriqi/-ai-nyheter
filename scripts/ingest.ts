import "dotenv/config";
import { siteConfig } from "@/lib/config";
import { createPrismaClient } from "@/lib/db";
import { runPipeline } from "@/lib/ingest/pipeline";
import { summarizePipeline } from "@/lib/ingest/summary";

// Synkroniserer kildene, henter nye elementer og sletter utløpt kildetekst.
// Kjøres med `npm run ingest`.
const db = createPrismaClient();
try {
  const result = await runPipeline(db, { config: siteConfig, trigger: "script" });
  for (const line of summarizePipeline(result).lines) {
    console.log(line);
  }
} finally {
  await db.$disconnect();
}
