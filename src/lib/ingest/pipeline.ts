import { type ClusterOptions, type ClusterResult, type JudgeSetup, runClusterJob } from "../cluster/run";
import type { SiteConfig } from "../config/schema";
import { type GenerateAgents, type GenerateOptions, type GenerateResult, runGenerateJob } from "../generate/run";
import type { Db } from "../db";
import { runRetentionJob } from "../retention";
import { type SyncResult, syncSourcesFromConfig } from "../sources/sync";
import type { FetchLike } from "./http";
import { type IngestResult, runIngestJob } from "./run";

export type PipelineOptions = {
  config: SiteConfig;
  trigger: string;
  now?: Date;
  fetchImpl?: FetchLike;
  /** Se ClusterOptions.judge. Utelatt: Claude hvis det er satt opp. */
  judge?: JudgeSetup | null;
  /** Se GenerateOptions.agents. Utelatt: Claude hvis det er satt opp. */
  agents?: GenerateAgents | null;
};

/**
 * Hele den planlagte jobben: synkroniser kildene fra konfigurasjonen, hent
 * nye elementer, grupper dem i saker, skriv artikler for saker som er klare,
 * og slett kildetekst som har passert sletteperioden. Brukes av `npm run ingest`, cron-ruten og knappen i admin.
 *
 * Slettingen er et juridisk krav og kjører alltid, også når et tidligere steg
 * feiler. En feil i grupperingen eller skrivingen stopper ikke resten; den
 * meldes i resultatet.
 * En feil i synkroniseringen eller innhentingen kastes videre etter slettingen.
 */
export async function runPipeline(db: Db, { config, trigger, now, fetchImpl, judge, agents }: PipelineOptions) {
  const retain = () =>
    runRetentionJob(db, {
      now,
      trigger,
      sourceTextDays: config.retention.sourceTextDays,
      jobRunDays: config.retention.jobRunDays,
    });

  let steps: { sync: SyncResult; ingest: IngestResult; cluster: ClusterResult; generate: GenerateResult };
  try {
    const sync = await syncSourcesFromConfig(db, config.sources);
    const ingest = await runIngestJob(db, { config, trigger, now, fetchImpl });
    const cluster = await runClusterSafely(db, { config, trigger, now, judge });
    const generate = await runGenerateSafely(db, { config, trigger, now, agents });
    steps = { sync, ingest, cluster, generate };
  } catch (error) {
    try {
      await retain();
    } catch (retentionError) {
      console.error("Sletting av kildetekst feilet:", retentionError);
    }
    throw error;
  }
  const retention = await retain();
  return { ...steps, retention };
}

/** Kjører grupperingen og gjør en feil om til et resultat, så slettingen etterpå likevel kjører. */
async function runClusterSafely(db: Db, options: ClusterOptions): Promise<ClusterResult> {
  try {
    return await runClusterJob(db, options);
  } catch (error) {
    console.error("Grupperingen feilet:", error);
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Kjører skrivingen og gjør en feil om til et resultat, så slettingen etterpå likevel kjører. */
async function runGenerateSafely(db: Db, options: GenerateOptions): Promise<GenerateResult> {
  try {
    return await runGenerateJob(db, options);
  } catch (error) {
    console.error("Skrivingen feilet:", error);
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** true hvis et steg feilet, så cron-ruten og skriptet kan melde det til overvåkingen. */
export function pipelineFailed(result: { cluster: ClusterResult; generate: GenerateResult }): boolean {
  return result.cluster.status === "failed" || result.generate.status === "failed";
}
