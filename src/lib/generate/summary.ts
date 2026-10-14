import type { GenerateResult, GenerateStats } from "./run";

/** Kort norsk oppsummering av en skriving, brukt i admin, cron-svaret og skriptet. */
export function describeGenerateStats(stats: GenerateStats): string {
  if (stats.considered === 0) return "ingen saker klare for artikkel";
  const created = stats.pendingReview + stats.published;
  const parts = [`${created} ${created === 1 ? "ny artikkel" : "nye artikler"}`];
  if (stats.pendingReview) parts.push(`${stats.pendingReview} venter på godkjenning`);
  if (stats.published) parts.push(`${stats.published} publisert automatisk`);
  if (stats.flagged) parts.push(`${stats.flagged} flagget`);
  if (stats.blocked) parts.push(`${stats.blocked} med brudd på faste regler`);
  if (stats.failed) parts.push(`${stats.failed} feilet og prøves igjen`);
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
  return parts.join(", ");
}

export function describeGenerate(result: GenerateResult): string {
  if (result.status === "skipped") return `Skriving hoppet over: ${result.reason}.`;
  if (result.status === "failed") return `Skriving feilet: ${result.reason}. Sakene prøves igjen i neste kjøring.`;
  return `Skriving: ${describeGenerateStats(result.stats)}.`;
}
