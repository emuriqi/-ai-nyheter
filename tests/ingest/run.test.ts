import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSiteConfig, type SiteConfig } from "@/lib/config/schema";
import type { Db } from "@/lib/db";
import { runIngestJob } from "@/lib/ingest/run";
import { DAY_MS } from "@/lib/retention";
import { syncSourcesFromConfig } from "@/lib/sources/sync";
import { createFakeFetch, fixture, html, text, xml } from "../helpers/fake-fetch";
import { activeSource, validConfig } from "../helpers/fixtures";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-10-12T10:00:00Z");
const FEED = "https://example.no/rss";

function config(overrides: Parameters<typeof activeSource>[0] = {}): SiteConfig {
  return parseSiteConfig(validConfig({ sources: [activeSource({ feedUrl: FEED, ...overrides })] }));
}

describe("runIngestJob", () => {
  let db: Db;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    ({ db, cleanup } = createTestDb());
  });

  afterAll(() => cleanup());

  beforeEach(async () => {
    await db.sourceItem.deleteMany();
    await db.source.deleteMany();
    await db.jobRun.deleteMany();
  });

  async function run(cfg: SiteConfig, routes: Parameters<typeof createFakeFetch>[0], now = NOW) {
    await syncSourcesFromConfig(db, cfg.sources);
    const fake = createFakeFetch(routes);
    const result = await runIngestJob(db, { config: cfg, trigger: "test", now, fetchImpl: fake.fetchImpl });
    return { result, fake };
  }

  const feedOnly = { [FEED]: xml(fixture("rss2.xml")) };

  it("henter og lagrer nye elementer med slettedato, og hopper over for gamle", async () => {
    const { result } = await run(config(), feedOnly);
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.sources[0]).toMatchObject({ outcome: "fetched", created: 3, tooOld: 1 });

    const items = await db.sourceItem.findMany({ orderBy: { guid: "asc" } });
    expect(items.map((item) => item.guid)).toEqual(["https://example.no/sak/5", "sak-1", "sak-2"]);
    for (const item of items) {
      expect(item.deleteAfter.getTime()).toBe(NOW.getTime() + 30 * DAY_MS);
      expect(item.language).toBe("nb");
    }
    const withContent = items.find((item) => item.guid === "sak-2");
    expect(withContent?.bodyText).toBe("Første avsnitt av hele teksten.\nAndre avsnitt.");

    const source = await db.source.findUniqueOrThrow({ where: { slug: "testkilde" } });
    expect(source).toMatchObject({ robotsAllowed: true, tdmReservationFound: false, lastFetchError: null });
    expect(source.lastFetchedAt?.toISOString()).toBe(NOW.toISOString());

    const job = await db.jobRun.findFirstOrThrow({ where: { type: "INGEST" } });
    expect(job.status).toBe("SUCCEEDED");
  });

  it("henter ingenting fra kilder som ikke er aktive", async () => {
    const { result, fake } = await run(config({ status: "NEEDS_VERIFICATION", tdmReservation: "UNKNOWN" }), feedOnly);
    expect(result).toMatchObject({ status: "done", sources: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it("respekterer minste intervall mellom hentinger", async () => {
    await run(config(), feedOnly);
    const { result, fake } = await run(config(), feedOnly, new Date(NOW.getTime() + 10 * 60_000));
    expect(result).toMatchObject({ sources: [{ outcome: "skipped" }] });
    expect(fake.calls).toHaveLength(0);
  });

  it("lagrer ikke uendrede elementer på nytt, så slettefristen ikke forlenges", async () => {
    await run(config(), feedOnly);
    await db.sourceItem.updateMany({ data: { excerpt: null, bodyText: null, purgedAt: NOW } });

    const later = new Date(NOW.getTime() + 60 * 60_000);
    const { result } = await run(config(), feedOnly, later);
    expect(result).toMatchObject({ sources: [{ created: 0, updated: 0, unchanged: 3 }] });
    expect(await db.sourceItem.count({ where: { purgedAt: null } })).toBe(0);
  });

  it("oppdaterer elementer når innholdet endrer seg", async () => {
    await run(config(), feedOnly);
    const changed = fixture("rss2.xml").replace("3 prosent", "4 prosent");
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const { result } = await run(config(), { [FEED]: xml(changed) }, later);
    expect(result).toMatchObject({ sources: [{ created: 0, updated: 1, unchanged: 2 }] });

    const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-1" } });
    expect(item.excerpt).toContain("4 prosent");
    expect(item.deleteAfter.getTime()).toBe(later.getTime() + 30 * DAY_MS);
  });

  it("bruker betingede forespørsler og håndterer 304", async () => {
    await run(config(), { [FEED]: xml(fixture("rss2.xml"), { etag: '"v1"' }) });
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const { result, fake } = await run(config(), { [FEED]: new Response(null, { status: 304 }) }, later);
    expect(result).toMatchObject({ sources: [{ outcome: "not-modified" }] });
    expect(fake.calls.find((call) => call.url === FEED)?.headers["if-none-match"]).toBe('"v1"');
  });

  it("henter ikke når robots.txt sperrer feeden", async () => {
    const { result, fake } = await run(config(), {
      ...feedOnly,
      "https://example.no/robots.txt": text("User-agent: *\nDisallow: /rss\n"),
    });
    expect(result).toMatchObject({ sources: [{ outcome: "blocked" }] });
    expect(fake.urls()).not.toContain(FEED);
    expect(await db.sourceItem.count()).toBe(0);
    const source = await db.source.findUniqueOrThrow({ where: { slug: "testkilde" } });
    expect(source.robotsAllowed).toBe(false);
    expect(source.lastFetchError).toContain("robots.txt");
  });

  it("henter ikke når kilden har reservert seg mot tekst- og datautvinning", async () => {
    const cases: Record<string, Response>[] = [
      { "https://example.no/robots.txt": text("User-agent: GPTBot\nDisallow: /\n") },
      { "https://example.no/.well-known/tdmrep.json": text('[{"location": "/", "tdm-reservation": 1}]') },
      { [FEED]: xml(fixture("rss2.xml"), { "tdm-reservation": "1" }) },
    ];
    for (const routes of cases) {
      await db.source.deleteMany();
      const { result } = await run(config(), { ...feedOnly, ...routes });
      expect(result).toMatchObject({ sources: [{ outcome: "blocked" }] });
      const source = await db.source.findUniqueOrThrow({ where: { slug: "testkilde" } });
      expect(source.tdmReservationFound).toBe(true);
    }
    expect(await db.sourceItem.count()).toBe(0);
  });

  it("registrerer feil uten å stoppe jobben", async () => {
    const { result } = await run(config(), { [FEED]: text("server nede", 500) });
    expect(result).toMatchObject({ status: "done", sources: [{ outcome: "failed", reason: "Feeden svarte HTTP 500" }] });
  });

  describe("fulltekst fra artikkelsiden", () => {
    const withArticle = { ...feedOnly, "https://example.no/sak/1": html(fixture("article.html")) };

    it("henter hovedteksten for kilder som tillater det, uten bilder", async () => {
      const { result } = await run(config({ allowFullTextFetch: true }), withArticle);
      expect(result).toMatchObject({ sources: [{ fullTextFetched: 1 }] });
      const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-1" } });
      expect(item.bodyText).toContain("Eksempeltallet økte med tre prosent");
      expect(item.bodyText).not.toContain("Bunntekst");
      expect(item.bodyText).not.toContain("bilde.jpg");
    });

    it("henter ikke artikkelsiden uten tillatelse i konfigurasjonen", async () => {
      const { fake } = await run(config({ allowFullTextFetch: false }), withArticle);
      expect(fake.urls()).not.toContain("https://example.no/sak/1");
    });

    it("respekterer tdm-reservation på artikkelsiden", async () => {
      const reserved = fixture("article.html").replace("<head>", '<head><meta name="tdm-reservation" content="1">');
      await run(config({ allowFullTextFetch: true }), { ...feedOnly, "https://example.no/sak/1": html(reserved) });
      const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-1" } });
      expect(item.bodyText).toBeNull();
      expect(item.excerpt).toBe("Eksempeltallet økte med 3 prosent & mer.");
    });

    it("henter ikke sider på andre verter enn kildens egne", async () => {
      const foreign = fixture("rss2.xml").replace("https://example.no/sak/1", "https://annen.no/sak/1");
      const { fake } = await run(config({ allowFullTextFetch: true }), {
        [FEED]: xml(foreign),
        "https://annen.no/sak/1": html(fixture("article.html")),
      });
      expect(fake.urls().some((url) => url.startsWith("https://annen.no"))).toBe(false);
    });
  });

  it("kutter tekst etter konfigurasjonen", async () => {
    const long = fixture("rss2.xml").replace("Kort ingress.", "Lang ingress. ".repeat(100));
    await run(config(), { [FEED]: xml(long) });
    const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-2" } });
    expect(item.excerpt!.length).toBeLessThanOrEqual(300);
    expect(item.excerpt!.endsWith("…")).toBe(true);
  });

  it("starter ikke en ny innhenting mens en annen kjører", async () => {
    await db.jobRun.create({ data: { type: "INGEST", trigger: "cron", startedAt: NOW } });
    const { result, fake } = await run(config(), feedOnly);
    expect(result).toEqual({ status: "skipped", reason: "En innhenting kjører allerede" });
    expect(fake.calls).toHaveLength(0);
  });
});
