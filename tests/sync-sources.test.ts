import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  const sources = (...inputs: ReturnType<typeof activeSource>[]) =>
    parseSiteConfig(validConfig({ sources: inputs })).sources;

  it("oppretter kildene første gang og oppdaterer dem siden", async () => {
    const first = await syncSourcesFromConfig(
      db,
      sources(activeSource({ slug: "a" }), activeSource({ slug: "b" })),
    );
    expect(first).toEqual({ created: 2, updated: 0, paused: 0 });

    const second = await syncSourcesFromConfig(
      db,
      sources(activeSource({ slug: "a", name: "Nytt navn" }), activeSource({ slug: "b" })),
    );
    expect(second).toEqual({ created: 0, updated: 2, paused: 0 });

    const a = await db.source.findUniqueOrThrow({ where: { slug: "a" } });
    expect(a.name).toBe("Nytt navn");
    expect(a.termsReviewedAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("setter kilder som er fjernet fra konfigurasjonen på pause i stedet for å slette dem", async () => {
    const result = await syncSourcesFromConfig(db, sources(activeSource({ slug: "a" })));
    expect(result.paused).toBe(1);

    const b = await db.source.findUniqueOrThrow({ where: { slug: "b" } });
    expect(b.status).toBe("PAUSED");
  });
});
