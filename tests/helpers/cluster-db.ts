import type { Db } from "@/lib/db";
import { parseSiteConfig, type SiteConfig } from "@/lib/config/schema";
import { computeDeleteAfter } from "@/lib/retention";
import { syncSourcesFromConfig } from "@/lib/sources/sync";
import type { CorpusItem } from "./cluster-corpus";
import { activeSource, validConfig } from "./fixtures";

/** Konfigurasjon med én aktiv og én satt på pause, og gruppering uten Claude. */
export function clusterConfig(overrides: Partial<SiteConfig["clustering"]> = {}): SiteConfig {
  const config = parseSiteConfig(
    validConfig({ sources: [activeSource({ slug: "aktiv" }), activeSource({ slug: "pause", status: "PAUSED" })] }),
  );
  return { ...config, clustering: { ...config.clustering, ...overrides } };
}

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

export function insertCorpusItem(db: Db, sourceId: string, item: CorpusItem) {
  return insertItem(db, sourceId, {
    guid: item.id,
    title: item.title,
    excerpt: item.excerpt,
    bodyText: item.bodyText,
    publishedAt: new Date(item.publishedAt),
  });
}
