import "dotenv/config";
import { createClaudeClient } from "@/lib/ai/claude";
import { Clusterer, type StoryJudge } from "@/lib/cluster/assign";
import { pairwiseScores } from "@/lib/cluster/evaluate";
import { createClaudeJudge } from "@/lib/cluster/judge";
import { siteConfig } from "@/lib/config";
import { loadCorpus, toMembers } from "../tests/helpers/cluster-corpus";

// Måler grupperingen på det syntetiske testkorpuset (tests/fixtures/cluster-corpus.json)
// med grensene i config/site.config.ts. Kjøres med `npm run eval:cluster`.
// Med `-- --claude` avgjør Claude gråsonen (krever ANTHROPIC_API_KEY og koster
// om lag 15 korte kall).

const items = loadCorpus();
const members = toMembers(items);
const truth = new Map(items.map((item) => [item.id, item.event]));
const title = new Map(items.map((item) => [item.id, item.title]));
const { clustering, ai } = siteConfig;

async function evaluate(name: string, judge: StoryJudge | null) {
  const clusterer = new Clusterer({
    windowMs: clustering.storyWindowHours * 3600_000,
    sameStoryThreshold: clustering.sameStoryThreshold,
    borderlineThreshold: clustering.borderlineThreshold,
    judge,
    maxJudgeCalls: 1000,
  });
  const predicted = new Map<string, string>();
  const storyIds = new Map<object, string>();
  for (const member of members) {
    const { story } = await clusterer.place(member);
    if (!storyIds.has(story)) storyIds.set(story, `s${storyIds.size + 1}`);
    predicted.set(member.id, storyIds.get(story)!);
  }
  const s = pairwiseScores(truth, predicted);
  const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
  console.log(`\n${name}`);
  console.log(`  Presisjon ${pct(s.precision)}, dekning ${pct(s.recall)}, F1 ${pct(s.f1)}`);
  console.log(`  ${storyIds.size} saker (fasit: ${new Set(truth.values()).size}), ${clusterer.judgeCalls} vurderinger`);

  // Viser hva som gikk galt, så grensene kan vurderes.
  const ids = [...truth.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const same = truth.get(ids[i]) === truth.get(ids[j]);
      const together = predicted.get(ids[i]) === predicted.get(ids[j]);
      if (!same && together) console.log(`  Feil sammenslått: «${title.get(ids[i])}» + «${title.get(ids[j])}»`);
    }
  }
}

console.log(
  `Korpus: ${items.length} syntetiske elementer. Samme sak fra likhet ${clustering.sameStoryThreshold}, ` +
    `gråsone fra ${clustering.borderlineThreshold}, tidsvindu ${clustering.storyWindowHours} timer.`,
);
await evaluate("Uten Claude (gråsonen blir egne saker):", null);

if (process.argv.includes("--claude")) {
  const client = createClaudeClient();
  if (!client) {
    console.error("\nANTHROPIC_API_KEY er ikke satt. Legg den i .env for å teste med Claude.");
    process.exitCode = 1;
  } else {
    const claude = createClaudeJudge(client, ai.model);
    await evaluate(`Med ${ai.model} i gråsonen:`, claude.judge);
    const u = claude.usage;
    console.log(`  ${u.calls} kall, ${u.failures} uten svar, ${u.inputTokens} inn- og ${u.outputTokens} ut-tokens`);
  }
}
