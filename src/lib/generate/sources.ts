import type { GenerationConfig } from "../config/schema";
import { escapeTags } from "../ai/structured";
import { itemTime } from "../cluster/run";
import { normalizeWhitespace, truncate } from "../ingest/text";

/** Et kildeelement slik det hentes fra databasen for en artikkel. */
export type SourceRow = {
  id: string;
  title: string;
  url: string;
  excerpt: string | null;
  bodyText: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  source: { name: string; publisher: string };
};

/** En kilde slik Claude ser den: nummerert K1, K2 … */
export type PreparedSource = {
  key: string;
  itemId: string;
  publisher: string;
  title: string;
  url: string;
  publishedAt: Date;
  text: string;
};

/**
 * Velger og forbereder kildene til en artikkel: de nyeste
 * `maxSourcesPerArticle` elementene i tidsrekkefølge, med utdrag og brødtekst
 * slått sammen og kuttet så summen holder seg under budsjettet. Bare teksten
 * Claude får se, brukes senere i kontrollene.
 */
export function prepareSources(rows: SourceRow[], settings: GenerationConfig): PreparedSource[] {
  const chosen = [...rows]
    .sort((a, b) => itemTime(a) - itemTime(b) || a.id.localeCompare(b.id))
    .slice(-settings.maxSourcesPerArticle);
  const perItem = Math.min(
    settings.maxSourceCharsPerItem,
    Math.floor(settings.maxSourceCharsTotal / Math.max(chosen.length, 1)),
  );
  return chosen.map((row, index) => ({
    key: `K${index + 1}`,
    itemId: row.id,
    publisher: row.source.publisher || row.source.name,
    title: normalizeWhitespace(row.title),
    url: row.url,
    publishedAt: new Date(itemTime(row)),
    text: truncate(combineText(row.excerpt, row.bodyText), perItem),
  }));
}

/** Utdrag og brødtekst, uten å gjenta utdraget når brødteksten begynner med det. */
function combineText(excerpt: string | null, bodyText: string | null): string {
  const lead = normalizeWhitespace(excerpt ?? "");
  const body = normalizeWhitespace(bodyText ?? "");
  if (!body) return lead;
  if (!lead || body.startsWith(lead.replace(/…$/, ""))) return body;
  return `${lead}\n\n${body}`;
}

/** Kildene som de står i meldingen til Claude. Teksten kan ikke lage egne tagger. */
export function formatSources(sources: PreparedSource[]): string {
  const blocks = sources.map((s) => {
    const attrs = `id="${s.key}" utgiver="${escapeAttr(s.publisher)}" publisert="${s.publishedAt.toISOString()}"`;
    return `<kilde ${attrs}>\nTittel: ${escapeTags(s.title)}\n\n${escapeTags(s.text)}\n</kilde>`;
  });
  return `<kilder>\n${blocks.join("\n\n")}\n</kilder>`;
}

function escapeAttr(value: string): string {
  return escapeTags(value).replace(/"/g, "'");
}
