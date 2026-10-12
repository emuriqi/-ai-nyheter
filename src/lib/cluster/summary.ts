import type { ClusterResult, ClusterStats } from "./run";

/** Kort norsk oppsummering av en gruppering, brukt i admin, cron-svaret og skriptet. */
export function describeClusterStats(stats: ClusterStats): string {
  if (stats.considered === 0 && stats.skipped === 0) return "ingen nye elementer";
  const created = stats.newStories + stats.newByClaude;
  const parts = [
    `${stats.considered} ${stats.considered === 1 ? "element" : "elementer"}`,
    `${created} ${created === 1 ? "ny sak" : "nye saker"}`,
    `${stats.joined + stats.joinedByClaude} lagt til eksisterende saker`,
  ];
  if (stats.claude && stats.claude.calls > 0) {
    parts.push(
      `Claude vurderte ${stats.claude.calls} (${stats.joinedByClaude} samme sak, ${stats.newByClaude} ny sak` +
        (stats.claude.failures ? `, ${stats.claude.failures} uten svar` : "") +
        ")",
    );
  }
  if (stats.uncertain) {
    parts.push(`${stats.uncertain} ${stats.uncertain === 1 ? "usikker" : "usikre"} bør sjekkes i admin`);
  }
  if (stats.skipped) parts.push(`${stats.skipped} allerede gruppert av en annen prosess`);
  return parts.join(", ");
}

export function describeCluster(result: ClusterResult): string {
  return result.status === "skipped"
    ? `Gruppering hoppet over: ${result.reason}.`
    : `Gruppering: ${describeClusterStats(result.stats)}.`;
}
