import type { GenerateResult, GenerateStats } from "./run";

/** Kort norsk oppsummering av en skriving, brukt i admin, cron-svaret og skriptet. */
export function describeGenerateStats(stats: GenerateStats): string {
  if (stats.considered === 0) return stats.stopped ? `stoppet: ${stats.stopped}` : "ingen saker klare for artikkel";
  const created = stats.pendingReview + stats.published;
  const parts = [`${created} ${created === 1 ? "ny artikkel" : "nye artikler"}`];
  if (stats.pendingReview) parts.push(`${stats.pendingReview} venter på godkjenning`);
  if (stats.published) parts.push(`${stats.published} publisert automatisk`);
  if (stats.flagged) parts.push(`${stats.flagged} flagget`);
  if (stats.blocked) parts.push(`${stats.blocked} med brudd på faste regler`);
  const retried = stats.failed - (stats.gaveUp ?? 0);
  if (retried) parts.push(`${retried} feilet og prøves igjen`);
  if (stats.gaveUp) parts.push(`${stats.gaveUp} gitt opp etter for mange forsøk`);
  if (stats.changed) parts.push(`${stats.changed} fikk nye kilder underveis og skrives på nytt`);
  if (stats.skipped) parts.push(`${stats.skipped} fikk artikkel fra en annen prosess`);
  const calls = (stats.writer?.calls ?? 0) + (stats.moderator?.calls ?? 0);
  if (calls) {
    const tokens =
      (stats.writer?.inputTokens ?? 0) +
      (stats.writer?.outputTokens ?? 0) +
      (stats.moderator?.inputTokens ?? 0) +
      (stats.moderator?.outputTokens ?? 0);
    parts.push(`${calls} kall til Claude (${tokens} tokens)`);
  }
  if (stats.stopped) parts.push(`stoppet: ${stats.stopped}`);
  return parts.join(", ");
}

export function describeGenerate(result: GenerateResult): string {
  if (result.status === "skipped") return `Skriving hoppet over: ${result.reason}.`;
  if (result.status === "failed") return `Skriving feilet: ${result.reason}. Sakene prøves igjen i neste kjøring.`;
  if (result.status === "stopped") {
    return `Skriving stoppet av en feil hos Claude API (${result.reason}): ${describeGenerateStats(result.stats)}. Resten prøves i neste kjøring.`;
  }
  return `Skriving: ${describeGenerateStats(result.stats)}.`;
}
