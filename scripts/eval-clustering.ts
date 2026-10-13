import "dotenv/config";
import { createClaudeClient } from "@/lib/ai/claude";
import type { StoryJudge } from "@/lib/cluster/assign";
import { pairwiseScores } from "@/lib/cluster/evaluate";
import { createClaudeJudge } from "@/lib/cluster/judge";
import { clustererOptions } from "@/lib/cluster/options";
import { siteConfig } from "@/lib/config";
import { clusterCorpus, type CorpusItem, loadCorpus, oracleJudge, toMembers } from "../tests/helpers/cluster-corpus";

// Måler grupperingen på det syntetiske testkorpuset (tests/fixtures/cluster-corpus*.json)
// med innstillingene i config/site.config.ts. Kjøres med `npm run eval:cluster`.
// Med `-- --claude` avgjør Claude gråsonen (krever ANTHROPIC_API_KEY og koster
// om lag 25 korte kall per korpus).

const { clustering, ai } = siteConfig;
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;

async function evaluate(
  name: string,
  items: CorpusItem[],
  judgeFor: (members: ReturnType<typeof toMembers>) => StoryJudge | null,
) {
  const members = toMembers(items);
  const truth = new Map(items.map((item) => [item.id, item.event]));
  const title = new Map(items.map((item) => [item.id, item.title]));
  const { predicted, stories, judgeCalls } = await clusterCorpus(
    members,
    clustererOptions(clustering, judgeFor(members), 1000),
  );
  const s = pairwiseScores(truth, predicted);
  console.log(
    `  ${name}: presisjon ${pct(s.precision)}, dekning ${pct(s.recall)}, ${stories} saker, ${judgeCalls} vurderinger`,
  );

  // Viser feil sammenslåinger, så grensene kan vurderes.
  const ids = [...truth.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const same = truth.get(ids[i]) === truth.get(ids[j]);
      const together = predicted.get(ids[i]) === predicted.get(ids[j]);
      if (!same && together) console.log(`    Feil sammenslått: «${title.get(ids[i])}» + «${title.get(ids[j])}»`);
    }
  }
}

console.log(
  `Samme sak fra likhet ${clustering.sameStoryThreshold} (mot en annen kilde), gråsone fra ${clustering.borderlineThreshold}, ` +
    `tidsvindu ${clustering.storyWindowHours} timer, saker på maks ${clustering.maxStoryHours} timer.`,
);
const claude = process.argv.includes("--claude") ? createClaudeClient() : null;
if (process.argv.includes("--claude") && !claude) {
  console.error("ANTHROPIC_API_KEY er ikke satt. Legg den i .env for å teste med Claude.");
  process.exitCode = 1;
}

for (const [label, items] of [
  ["Hovedkorpuset", loadCorpus()],
  ["Hovedkorpuset med vanskelige tilfeller", loadCorpus({ hard: true })],
] as const) {
  console.log(`\n${label} (${items.length} elementer, ${new Set(items.map((i) => i.event)).size} saker i fasiten):`);
  await evaluate("Uten Claude", items, () => null);
  await evaluate("Perfekt dommer i gråsonen", items, (members) => oracleJudge(items, members));
  if (claude) {
    const setup = createClaudeJudge(claude, ai.model);
    await evaluate(`Med ${ai.model} i gråsonen`, items, () => setup.judge);
    const u = setup.usage;
    console.log(`    ${u.calls} kall, ${u.failures} uten svar, ${u.inputTokens} inn- og ${u.outputTokens} ut-tokens`);
  }
}
