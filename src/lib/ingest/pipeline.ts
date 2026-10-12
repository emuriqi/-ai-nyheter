import { type JudgeSetup, runClusterJob } from "../cluster/run";
import type { SiteConfig } from "../config/schema";
import type { Db } from "../db";
import { runRetentionJob } from "../retention";
import { syncSourcesFromConfig } from "../sources/sync";
import type { FetchLike } from "./http";
import { runIngestJob } from "./run";

export type PipelineOptions = {
  config: SiteConfig;
  trigger: string;
  now?: Date;
  fetchImpl?: FetchLike;
  /** Se ClusterOptions.judge. Utelatt: Claude hvis det er satt opp. */
  judge?: JudgeSetup | null;
};

/**
 * Hele den planlagte jobben: synkroniser kildene fra konfigurasjonen, hent
 * nye elementer, grupper dem i saker og slett kildetekst som har passert
 * sletteperioden. Brukes av `npm run ingest`, cron-ruten og knappen i admin.
 */
export async function runPipeline(db: Db, { config, trigger, now, fetchImpl, judge }: PipelineOptions) {
  const sync = await syncSourcesFromConfig(db, config.sources);
  const ingest = await runIngestJob(db, { config, trigger, now, fetchImpl });
  const cluster = await runClusterJob(db, { config, trigger, now, judge });
  const retention = await runRetentionJob(db, {
    now,
    trigger,
    sourceTextDays: config.retention.sourceTextDays,
    jobRunDays: config.retention.jobRunDays,
  });
  return { sync, ingest, cluster, retention };
}
