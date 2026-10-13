import { readFileSync } from "node:fs";
import path from "node:path";
import { Clusterer, type ClustererOptions, type Member, type StoryJudge } from "@/lib/cluster/assign";
import { type ItemText, TermStats, termFrequencies, weigh } from "@/lib/cluster/features";

export type CorpusItem = ItemText & {
  id: string;
  /** Kildestilen (varsel, etat, departement …). Brukes som kilde. */
  source: string;
  /** Fasit: elementer med samme event er samme sak. */
  event: string;
  publishedAt: string;
};

function readFixture(name: string): CorpusItem[] {
  const file = path.join(import.meta.dirname, "..", "fixtures", name);
  return (JSON.parse(readFileSync(file, "utf8")) as { items: CorpusItem[] }).items;
}

/**
 * Det syntetiske korpuset, sortert på tid: tests/fixtures/cluster-corpus.json,
 * og med `hard: true` også tillegget med vanskelige tilfeller
 * (cluster-corpus-hard.json).
 */
export function loadCorpus({ hard = false }: { hard?: boolean } = {}): CorpusItem[] {
  const items = [...readFixture("cluster-corpus.json"), ...(hard ? readFixture("cluster-corpus-hard.json") : [])];
  return items.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
}

/** Gjør korpuset om til elementer for grupperingen, med IDF fra hele korpuset. */
export function toMembers(items: CorpusItem[]): Member[] {
  const tfs = items.map((item) => termFrequencies(item));
  const stats = new TermStats(tfs);
  return items.map((item, i) => ({
    id: item.id,
    sourceId: item.source,
    time: Date.parse(item.publishedAt),
    vector: weigh(tfs[i], stats),
    text: { title: item.title, excerpt: item.excerpt, bodyText: item.bodyText },
  }));
}

export { pairwiseScores } from "@/lib/cluster/evaluate";

/**
 * En dommer som kjenner fasiten: velger kandidatsaken med et element fra samme
 * hendelse, ellers ny sak. Viser hva gråsonen kan gi med en perfekt vurdering.
 */
export function oracleJudge(items: CorpusItem[], members: Member[]): StoryJudge {
  const eventByText = new Map(members.map((m, i) => [m.text, items[i].event]));
  return async (item, candidates) => {
    const event = eventByText.get(item);
    const hit = candidates.find((c) => c.items.some((text) => eventByText.get(text) === event));
    return { match: hit ? hit.key : null, reason: "fasit" };
  };
}

/** Grupperer korpuset i minnet og returnerer sak per element. */
export async function clusterCorpus(members: Member[], options: ClustererOptions) {
  const clusterer = new Clusterer(options);
  const predicted = new Map<string, string>();
  const storyIds = new Map<object, string>();
  for (const member of members) {
    const { story } = await clusterer.place(member);
    if (!storyIds.has(story)) storyIds.set(story, `s${storyIds.size + 1}`);
    predicted.set(member.id, storyIds.get(story)!);
  }
  return { predicted, stories: storyIds.size, judgeCalls: clusterer.judgeCalls };
}
