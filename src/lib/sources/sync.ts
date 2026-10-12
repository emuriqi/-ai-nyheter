import type { Db } from "../db";
import type { SourceConfig } from "../config/schema";

export type SyncResult = { created: number; updated: number; paused: number };

/** Gjør om en kilde fra konfigurasjonen til felter i Source-tabellen. */
export function toSourceData(source: SourceConfig) {
  return {
    name: source.name,
    publisher: source.publisher,
    kind: source.kind,
    feedUrl: source.feedUrl,
    homepageUrl: source.homepageUrl,
    termsUrl: source.termsUrl,
    license: source.license,
    licenseNote: source.licenseNote,
    attribution: source.attribution,
    language: source.language,
    status: source.status,
    termsReviewedAt: source.termsReviewedAt ? new Date(`${source.termsReviewedAt}T00:00:00Z`) : null,
    tdmReservation: source.tdmReservation,
    allowFullTextFetch: source.allowFullTextFetch,
    notes: source.notes ?? null,
  };
}

/**
 * Synkroniserer kildene i databasen med konfigurasjonen, som er fasit.
 *
 * Kilder som er fjernet fra konfigurasjonen slettes ikke (elementene deres kan
 * være brukt i publiserte artikler), men settes på pause så de ikke hentes.
 */
export async function syncSourcesFromConfig(db: Db, sources: SourceConfig[]): Promise<SyncResult> {
  return db.$transaction(async (tx) => {
    let created = 0;
    let updated = 0;

    for (const source of sources) {
      const data = toSourceData(source);
      const existing = await tx.source.findUnique({
        where: { slug: source.slug },
        select: { id: true, feedUrl: true },
      });
      if (existing) {
        // Ny feed-adresse: de gamle validatorene (ETag/Last-Modified) gjelder ikke lenger.
        const feedChanged = existing.feedUrl !== data.feedUrl;
        await tx.source.update({
          where: { id: existing.id },
          data: feedChanged ? { ...data, etag: null, lastModified: null, lastAttemptAt: null } : data,
        });
        updated++;
      } else {
        await tx.source.create({ data: { slug: source.slug, ...data } });
        created++;
      }
    }

    const removed = await tx.source.updateMany({
      where: { slug: { notIn: sources.map((s) => s.slug) }, status: { not: "PAUSED" } },
      data: { status: "PAUSED" },
    });

    return { created, updated, paused: removed.count };
  });
}
