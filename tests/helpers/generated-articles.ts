import { readFileSync } from "node:fs";
import path from "node:path";
import type { WrittenArticle } from "@/lib/generate/schema";
import type { PreparedSource } from "@/lib/generate/sources";

type Fixture = {
  saker: Record<
    string,
    {
      kilder: { key: string; itemId: string; publisher: string; publishedAt: string; title: string; text: string }[];
      god: WrittenArticle;
      varianter: { feil: string; beskrivelse: string; artikkel: WrittenArticle }[];
    }
  >;
};

/** Syntetiske artikler i tests/fixtures/generated-articles.json: én god og fem med innplantede feil per sak. */
export function loadGeneratedArticles() {
  const file = path.join(import.meta.dirname, "..", "fixtures", "generated-articles.json");
  const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
  return Object.entries(fixture.saker).map(([event, sak]) => ({
    event,
    sources: sak.kilder.map(
      (k): PreparedSource => ({
        key: k.key,
        itemId: k.itemId,
        publisher: k.publisher,
        title: k.title,
        url: `https://example.no/${k.itemId}`,
        publishedAt: new Date(k.publishedAt),
        text: k.text,
      }),
    ),
    good: sak.god,
    variants: sak.varianter,
  }));
}
