import "dotenv/config";
import { siteConfig } from "@/lib/config";
import { createPrismaClient } from "@/lib/db";
import { pipelineFailed, runPipeline } from "@/lib/ingest/pipeline";
import { summarizePipeline } from "@/lib/ingest/summary";

// Synkroniserer kildene, henter nye elementer, grupperer dem i saker, skriver artikler og sletter utløpt kildetekst.
// Kjøres med `npm run ingest`.
const db = createPrismaClient();
try {
  const result = await runPipeline(db, { config: siteConfig, trigger: "script" });
  for (const line of summarizePipeline(result).lines) {
    console.log(line);
  }
  // Slettingen har kjørt uansett, men en feilet gruppering eller skriving skal gi feilkode.
  if (pipelineFailed(result)) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
