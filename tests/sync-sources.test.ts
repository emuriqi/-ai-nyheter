import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSiteConfig } from "@/lib/config/schema";
import type { Db } from "@/lib/db";
import { syncSourcesFromConfig } from "@/lib/sources/sync";
import { activeSource, validConfig } from "./helpers/fixtures";
import { createTestDb } from "./helpers/test-db";

describe("syncSourcesFromConfig", () => {
  let db: Db;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    ({ db, cleanup } = createTestDb());
  });

  afterAll(() => cleanup());

  beforeEach(async () => {
    await db.source.deleteMany();
  });

  const sources = (...inputs: ReturnType<typeof activeSource>[]) =>
    parseSiteConfig(validConfig({ sources: inputs })).sources;

  it("oppretter kildene med alle juridiske felter", async () => {
    const result = await syncSourcesFromConfig(
      db,
      sources(activeSource({ slug: "a", license: "NLOD-2.0", allowFullTextFetch: true }), activeSource({ slug: "b" })),
    );
    expect(result).toEqual({ created: 2, updated: 0, paused: 0 });

    const a = await db.source.findUniqueOrThrow({ where: { slug: "a" } });
    expect(a).toMatchObject({
      status: "ACTIVE",
      license: "NLOD-2.0",
      tdmReservation: "NONE_FOUND",
      allowFullTextFetch: true,
      feedUrl: "https://example.no/rss",
      termsUrl: "https://example.no/vilkar",
      attribution: "Kilde: Testutgiver, CC BY 4.0",
    });
    expect(a.termsReviewedAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("oppdaterer de juridiske feltene når konfigurasjonen endres", async () => {
    await syncSourcesFromConfig(db, sources(activeSource({ slug: "a", allowFullTextFetch: true })));

    const result = await syncSourcesFromConfig(
      db,
      sources(
        activeSource({
          slug: "a",
          name: "Nytt navn",
          status: "NEEDS_VERIFICATION",
          license: "UNKNOWN",
          tdmReservation: "RESERVED",
          termsReviewedAt: null,
          allowFullTextFetch: false,
        }),
      ),
    );
    expect(result).toEqual({ created: 0, updated: 1, paused: 0 });

    const a = await db.source.findUniqueOrThrow({ where: { slug: "a" } });
    expect(a).toMatchObject({
      name: "Nytt navn",
      status: "NEEDS_VERIFICATION",
      license: "UNKNOWN",
      tdmReservation: "RESERVED",
      termsReviewedAt: null,
      allowFullTextFetch: false,
    });
  });

  it("setter kilder som er fjernet fra konfigurasjonen på pause i stedet for å slette dem", async () => {
    await syncSourcesFromConfig(db, sources(activeSource({ slug: "a" }), activeSource({ slug: "b" })));

    const result = await syncSourcesFromConfig(db, sources(activeSource({ slug: "a" })));
    expect(result).toEqual({ created: 0, updated: 1, paused: 1 });

    const b = await db.source.findUniqueOrThrow({ where: { slug: "b" } });
    expect(b.status).toBe("PAUSED");
  });
});
