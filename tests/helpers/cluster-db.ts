import type { Db } from "@/lib/db";
import { parseSiteConfig, type SiteConfig } from "@/lib/config/schema";
import { computeDeleteAfter } from "@/lib/retention";
import { syncSourcesFromConfig } from "@/lib/sources/sync";
import type { CorpusItem } from "./cluster-corpus";
import { activeSource, validConfig } from "./fixtures";

/** Kildestilene i korpuset. Hver blir en egen aktiv kilde i testdatabasen. */
export const CORPUS_SOURCES = ["varsel", "etat", "departement", "stortinget", "statistikk", "kommune", "byraa"];

/**
 * Konfigurasjon med de aktive kildene `active` og én kilde på pause («pause»),
 * og gruppering uten Claude.
 */
export function clusterConfig(
  overrides: Partial<SiteConfig["clustering"]> = {},
  active: string[] = ["aktiv", "aktiv2"],
): SiteConfig {
  const config = parseSiteConfig(
    validConfig({
      sources: [
        ...active.map((slug) => activeSource({ slug, feedUrl: `https://example.no/${slug}/rss` })),
        activeSource({ slug: "pause", status: "PAUSED", feedUrl: "https://example.no/pause/rss" }),
      ],
    }),
  );
  return { ...config, clustering: { ...config.clustering, ...overrides } };
}

/** Synkroniserer kildene og gir id per slug. */
export async function sourceIds(db: Db, config: SiteConfig) {
  await syncSourcesFromConfig(db, config.sources);
  const sources = await db.source.findMany({ select: { id: true, slug: true } });
  return Object.fromEntries(sources.map((s) => [s.slug, s.id])) as Record<string, string>;
}

type ItemInput = {
  guid: string;
  title: string;
  excerpt?: string | null;
  bodyText?: string | null;
  publishedAt: Date | null;
  fetchedAt?: Date;
  tdmReserved?: boolean;
  purgedAt?: Date | null;
};

/** Lagrer et element slik innhentingen gjør, med hentetid fem minutter etter publisering. */
export async function insertItem(db: Db, sourceId: string, input: ItemInput) {
  const fetchedAt = input.fetchedAt ?? new Date((input.publishedAt?.getTime() ?? Date.now()) + 5 * 60_000);
  return db.sourceItem.create({
    data: {
      sourceId,
      guid: input.guid,
      url: `https://example.no/${input.guid}`,
      title: input.title,
      excerpt: input.excerpt ?? null,
      bodyText: input.bodyText ?? null,
      publishedAt: input.publishedAt,
      fetchedAt,
      tdmReserved: input.tdmReserved ?? false,
      purgedAt: input.purgedAt ?? null,
      language: "nb",
      deleteAfter: computeDeleteAfter(fetchedAt, 30),
    },
  });
}

/** Lagrer et korpuselement under kilden for kildestilen sin. */
export function insertCorpusItem(db: Db, sourceIdBySlug: Record<string, string>, item: CorpusItem) {
  return insertItem(db, sourceIdBySlug[item.source], {
    guid: item.id,
    title: item.title,
    excerpt: item.excerpt,
    bodyText: item.bodyText,
    publishedAt: new Date(item.publishedAt),
  });
}
