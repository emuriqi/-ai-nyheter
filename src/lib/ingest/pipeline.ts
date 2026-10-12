import type { SiteConfig } from "../config/schema";
import type { Db } from "../db";
import { runRetentionJob } from "../retention";
import { syncSourcesFromConfig } from "../sources/sync";
import type { FetchLike } from "./http";
import { runIngestJob } from "./run";

/**
 * Hele den planlagte jobben: synkroniser kildene fra konfigurasjonen, hent
 * nye elementer og slett kildetekst som har passert sletteperioden.
 * Brukes av `npm run ingest`, cron-ruten og knappen i admin.
 */
export async function runPipeline(
  db: Db,
  { config, trigger, now, fetchImpl }: { config: SiteConfig; trigger: string; now?: Date; fetchImpl?: FetchLike },
) {
  const sync = await syncSourcesFromConfig(db, config.sources);
  const ingest = await runIngestJob(db, { config, trigger, now, fetchImpl });
  const retention = await runRetentionJob(db, {
    now,
    trigger,
    sourceTextDays: config.retention.sourceTextDays,
    jobRunDays: config.retention.jobRunDays,
  });
  return { sync, ingest, retention };
}
