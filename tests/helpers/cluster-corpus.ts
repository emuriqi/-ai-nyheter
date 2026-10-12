import { readFileSync } from "node:fs";
import path from "node:path";
import { type Member } from "@/lib/cluster/assign";
import { type ItemText, TermStats, termFrequencies, weigh } from "@/lib/cluster/features";

export type CorpusItem = ItemText & {
  id: string;
  source: string;
  /** Fasit: elementer med samme event er samme sak. */
  event: string;
  publishedAt: string;
};

/** Det syntetiske korpuset i tests/fixtures/cluster-corpus.json, sortert på tid. */
export function loadCorpus(): CorpusItem[] {
  const file = path.join(import.meta.dirname, "..", "fixtures", "cluster-corpus.json");
  const corpus = JSON.parse(readFileSync(file, "utf8")) as { items: CorpusItem[] };
  return [...corpus.items].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

/** Gjør korpuset om til elementer for grupperingen, med IDF fra hele korpuset. */
export function toMembers(items: CorpusItem[]): Member[] {
  const tfs = items.map((item) => termFrequencies(item));
  const stats = new TermStats(tfs);
  return items.map((item, i) => ({
    id: item.id,
    time: Date.parse(item.publishedAt),
    vector: weigh(tfs[i], stats),
    text: { title: item.title, excerpt: item.excerpt, bodyText: item.bodyText },
  }));
}

export { pairwiseScores } from "@/lib/cluster/evaluate";
