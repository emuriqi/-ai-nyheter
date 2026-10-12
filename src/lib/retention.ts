import type { Db } from "./db";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Når kildeteksten til et element hentet `fetchedAt` skal slettes. */
export function computeDeleteAfter(fetchedAt: Date, retentionDays: number): Date {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RangeError(`Sletteperioden må være et helt antall dager ≥ 1, fikk ${retentionDays}.`);
  }
  return new Date(fetchedAt.getTime() + retentionDays * DAY_MS);
}

/**
 * Sletter kildetekst (utdrag og brødtekst) som har passert sletteperioden.
 *
 * Tittel, URL og hash beholdes slik at artikler fortsatt kan liste og lenke
 * til kildene sine. Både lagret `deleteAfter` og gjeldende sletteperiode
 * sjekkes, slik at en kortere periode i konfigurasjonen også gjelder tekst
 * som allerede er lagret.
 */
export async function purgeExpiredSourceText(
  db: Db,
  { now, retentionDays }: { now: Date; retentionDays: number },
): Promise<{ purged: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const result = await db.sourceItem.updateMany({
    where: {
      AND: [
        { OR: [{ deleteAfter: { lte: now } }, { fetchedAt: { lte: cutoff } }] },
        { OR: [{ excerpt: { not: null } }, { bodyText: { not: null } }] },
      ],
    },
    data: { excerpt: null, bodyText: null, purgedAt: now },
  });
  return { purged: result.count };
}

/** Sletter gamle innslag i jobbloggen, også jobber som ble avbrutt underveis. */
export async function pruneJobRuns(
  db: Db,
  { now, retentionDays }: { now: Date; retentionDays: number },
): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const result = await db.jobRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
  return { deleted: result.count };
}

/** Ingen jobb skal ta så lang tid. Eldre jobber med status RUNNING ble avbrutt. */
export const STALE_JOB_MS = 6 * 60 * 60 * 1000;

/** Markerer jobber som ble avbrutt (f.eks. ved at prosessen døde) som feilet. */
export async function failStaleJobRuns(db: Db, now: Date): Promise<{ failed: number }> {
  const result = await db.jobRun.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_JOB_MS) } },
    data: { status: "FAILED", finishedAt: now, error: "Avbrutt før jobben ble ferdig" },
  });
  return { failed: result.count };
}

/** Kjører all sletting etter konfigurasjonen og logger kjøringen som en JobRun. */
export async function runRetentionJob(
  db: Db,
  {
    now = new Date(),
    trigger,
    sourceTextDays,
    jobRunDays,
  }: { now?: Date; trigger: string; sourceTextDays: number; jobRunDays: number },
) {
  await failStaleJobRuns(db, now);
  const job = await db.jobRun.create({ data: { type: "PURGE", trigger, startedAt: now } });
  try {
    const { purged } = await purgeExpiredSourceText(db, { now, retentionDays: sourceTextDays });
    const { deleted } = await pruneJobRuns(db, { now, retentionDays: jobRunDays });
    const stats = { purgedSourceItems: purged, deletedJobRuns: deleted };
    await db.jobRun.update({
      where: { id: job.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), stats },
    });
    return stats;
  } catch (error) {
    await db.jobRun.update({
      where: { id: job.id },
      data: { status: "FAILED", finishedAt: new Date(), error: String(error) },
    });
    throw error;
  }
}
