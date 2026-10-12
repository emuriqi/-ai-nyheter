import type { runPipeline } from "./pipeline";
import type { SourceRunResult } from "./run";

const OUTCOME_LABEL: Record<SourceRunResult["outcome"], string> = {
  fetched: "hentet",
  "not-modified": "ingen endringer",
  skipped: "hoppet over",
  blocked: "sperret",
  failed: "feilet",
};

/** Kort norsk oppsummering av én kilde, f.eks. «ssb: hentet, 3 nye, 1 endret». */
export function describeSource(result: SourceRunResult): string {
  const parts = [OUTCOME_LABEL[result.outcome]];
  if (result.created) parts.push(`${result.created} nye`);
  if (result.updated) parts.push(`${result.updated} endret`);
  if (result.fullTextFetched) parts.push(`${result.fullTextFetched} med fulltekst`);
  if (result.tooOld) parts.push(`${result.tooOld} for gamle`);
  if (result.reason) parts.push(result.reason);
  return `${result.slug}: ${parts.join(", ")}`;
}

/** Oppsummering av en hel kjøring som JSON-vennlig objekt (cron-ruten) og tekstlinjer (script). */
export function summarizePipeline(result: Awaited<ReturnType<typeof runPipeline>>) {
  const { sync, ingest, retention } = result;
  const lines = [
    `Kilder synkronisert: ${sync.created} nye, ${sync.updated} oppdatert, ${sync.paused} satt på pause.`,
  ];
  if (ingest.status === "skipped") {
    lines.push(`Innhenting hoppet over: ${ingest.reason}.`);
  } else if (ingest.sources.length === 0) {
    lines.push("Ingen aktive kilder. En kilde hentes bare når den er ACTIVE i config/site.config.ts.");
  } else {
    lines.push(...ingest.sources.map(describeSource));
  }
  lines.push(
    `Sletting: kildetekst fjernet fra ${retention.purgedSourceItems} elementer, ${retention.deletedJobRuns} gamle jobblogger slettet.`,
  );
  return { lines, sync, ingest, retention };
}
