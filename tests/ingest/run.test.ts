import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSiteConfig, type SiteConfig } from "@/lib/config/schema";
import type { Db } from "@/lib/db";
import { claimSource, runIngestJob } from "@/lib/ingest/run";
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

    it("lagrer bare tittel og lenke når artikkelsiden reserverer seg (meta eller header)", async () => {
      const metaReserved = fixture("article.html").replace("<head>", '<head><meta name="tdm-reservation" content="1">');
      for (const page of [html(metaReserved), html(fixture("article.html"), { "tdm-reservation": "1" })]) {
        await db.sourceItem.deleteMany();
        await db.source.deleteMany();
        const { result } = await run(config({ allowFullTextFetch: true }), { ...feedOnly, "https://example.no/sak/1": page });
        expect(result).toMatchObject({ sources: [{ reserved: 1, fullTextFetched: 0 }] });
        const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-1" } });
        expect(item).toMatchObject({ tdmReserved: true, bodyText: null, excerpt: null, title: "Ny statistikk om eksempeltall" });
      }
    });

    it("henter ikke artikkelsider som robots.txt sperrer, og lagrer feedteksten", async () => {
      const { fake } = await run(config({ allowFullTextFetch: true }), {
        ...withArticle,
        "https://example.no/robots.txt": text("User-agent: *\nDisallow: /sak/\n"),
      });
      expect(fake.urls()).not.toContain("https://example.no/sak/1");
      const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-1" } });
      expect(item).toMatchObject({ bodyText: null, tdmReserved: false });
      expect(item.excerpt).toContain("Eksempeltallet");
    });

    it("følger ikke en omdirigering fra artikkelen til en sti robots.txt sperrer", async () => {
      const { fake } = await run(config({ allowFullTextFetch: true }), {
        ...feedOnly,
        "https://example.no/robots.txt": text("User-agent: *\nDisallow: /betalt/\n"),
        "https://example.no/sak/1": new Response(null, { status: 302, headers: { location: "/betalt/sak/1" } }),
        "https://example.no/betalt/sak/1": html(fixture("article.html")),
      });
      expect(fake.urls()).not.toContain("https://example.no/betalt/sak/1");
      const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-1" } });
      expect(item.bodyText).toBeNull();
    });

    it("lagrer ingen brødtekst når artikkelsiden svarer med feil", async () => {
      const { result } = await run(config({ allowFullTextFetch: true }), {
        ...feedOnly,
        "https://example.no/sak/1": text("finnes ikke", 404),
      });
      expect(result).toMatchObject({ sources: [{ fullTextFetched: 0, created: 3 }] });
      expect((await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-1" } })).bodyText).toBeNull();
    });

    it("kutter fulltekst etter maxTextChars", async () => {
      const long = fixture("article.html").replace(
        "<p>Et tredje avsnitt",
        `<p>${"Mye mer tekst om eksempeltallet. ".repeat(200)}</p><p>Et tredje avsnitt`,
      );
      await run(config({ allowFullTextFetch: true }), { ...feedOnly, "https://example.no/sak/1": html(long) });
      const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-1" } });
      expect(item.bodyText!.length).toBeLessThanOrEqual(2000);
      expect(item.bodyText!.endsWith("…")).toBe(true);
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

  it("lagrer bare tittel og lenke for artikler kilden har reservert i tdmrep.json eller robots.txt", async () => {
    const cases: Record<string, Response>[] = [
      { "https://example.no/.well-known/tdmrep.json": text(JSON.stringify([{ location: "/sak/", "tdm-reservation": 1 }])) },
      { "https://example.no/robots.txt": text("User-agent: GPTBot\nDisallow: /sak/\n") },
    ];
    for (const routes of cases) {
      await db.sourceItem.deleteMany();
      await db.source.deleteMany();
      const { result } = await run(config(), { ...feedOnly, ...routes });
      expect(result).toMatchObject({ sources: [{ outcome: "fetched", created: 3, reserved: 3 }] });
      const items = await db.sourceItem.findMany();
      for (const item of items) {
        expect(item).toMatchObject({ tdmReserved: true, excerpt: null, bodyText: null });
      }
    }
  });

  it("fjerner lagret tekst når kilden senere reserverer artikkelen", async () => {
    await run(config(), feedOnly);
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const { result } = await run(
      config(),
      { ...feedOnly, "https://example.no/.well-known/tdmrep.json": text('[{"location": "/sak/1", "tdm-reservation": 1}]') },
      later,
    );
    expect(result).toMatchObject({ sources: [{ updated: 1, reserved: 1 }] });
    const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "sak-1" } });
    expect(item).toMatchObject({ tdmReserved: true, excerpt: null });
  });

  it("følger ikke en omdirigering fra feeden til en sti robots.txt sperrer", async () => {
    const { result, fake } = await run(config(), {
      [FEED]: new Response(null, { status: 301, headers: { location: "/privat/rss" } }),
      "https://example.no/privat/rss": xml(fixture("rss2.xml")),
      "https://example.no/robots.txt": text("User-agent: *\nDisallow: /privat/\n"),
    });
    expect(result).toMatchObject({ sources: [{ outcome: "blocked" }] });
    expect(fake.urls()).not.toContain("https://example.no/privat/rss");
    expect(await db.sourceItem.count()).toBe(0);
  });

  it("lagrer bare én av to elementer med samme guid, og bytter ikke frem og tilbake", async () => {
    const twins = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title>Første</title><link>https://example.no/samme</link><description>Tekst A</description><pubDate>Mon, 12 Oct 2026 08:00:00 +0200</pubDate></item>
      <item><title>Andre</title><link>https://example.no/samme</link><description>Tekst B</description><pubDate>Mon, 12 Oct 2026 07:00:00 +0200</pubDate></item>
    </channel></rss>`;
    const { result } = await run(config(), { [FEED]: xml(twins) });
    expect(result).toMatchObject({ sources: [{ created: 1, updated: 0 }] });
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const { result: second } = await run(config(), { [FEED]: xml(twins) }, later);
    expect(second).toMatchObject({ sources: [{ created: 0, updated: 0, unchanged: 1 }] });
    expect((await db.sourceItem.findFirstOrThrow()).title).toBe("Første");
  });

  it("sender User-Agent fra konfigurasjonen og behandler bare de nyeste elementene", async () => {
    const cfg = parseSiteConfig(
      validConfig({
        ingestion: { ...validConfig().ingestion!, maxItemsPerSource: 1 },
        sources: [activeSource({ feedUrl: FEED })],
      }),
    );
    const { fake } = await run(cfg, feedOnly);
    for (const call of fake.calls) {
      expect(call.headers["user-agent"]).toBe(cfg.ingestion.userAgent);
    }
    expect((await db.sourceItem.findMany()).map((item) => item.guid)).toEqual(["sak-1"]);
  });

  it("bruker Last-Modified og beholder validatorene etter 304", async () => {
    await run(config(), { [FEED]: xml(fixture("rss2.xml"), { "last-modified": "Mon, 12 Oct 2026 09:00:00 GMT" }) });
    const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const { fake } = await run(config(), { [FEED]: new Response(null, { status: 304 }) }, later(60));
    expect(fake.calls.find((call) => call.url === FEED)?.headers["if-modified-since"]).toBe("Mon, 12 Oct 2026 09:00:00 GMT");
    const { fake: third } = await run(config(), { [FEED]: new Response(null, { status: 304 }) }, later(120));
    expect(third.calls.find((call) => call.url === FEED)?.headers["if-modified-since"]).toBe("Mon, 12 Oct 2026 09:00:00 GMT");
  });

  it("stopper en 304 med tdm-reservation og fjerner validatorene", async () => {
    await run(config(), { [FEED]: xml(fixture("rss2.xml"), { etag: '"v1"' }) });
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const { result } = await run(
      config(),
      { [FEED]: new Response(null, { status: 304, headers: { "tdm-reservation": "1" } }) },
      later,
    );
    expect(result).toMatchObject({ sources: [{ outcome: "blocked" }] });
    const source = await db.source.findUniqueOrThrow({ where: { slug: "testkilde" } });
    expect(source).toMatchObject({ tdmReservationFound: true, etag: null, lastModified: null });
  });

  it("registrerer at TDM ikke ble vurdert når robots.txt sperrer, og ukjent når tdmrep.json ikke kan leses", async () => {
    await run(config(), {
      ...feedOnly,
      "https://example.no/robots.txt": text("User-agent: *\nDisallow: /rss\n"),
      "https://example.no/.well-known/tdmrep.json": text('[{"location": "/", "tdm-reservation": 1}]'),
    });
    const blocked = await db.source.findUniqueOrThrow({ where: { slug: "testkilde" } });
    expect(blocked).toMatchObject({ robotsAllowed: false, tdmCheckedAt: null, tdmReservationFound: null });

    await db.source.deleteMany();
    await run(config(), { ...feedOnly, "https://example.no/.well-known/tdmrep.json": text("feil", 503) });
    const unknown = await db.source.findUniqueOrThrow({ where: { slug: "testkilde" } });
    expect(unknown).toMatchObject({ robotsAllowed: true, tdmReservationFound: null });
    expect(unknown.tdmCheckedAt).not.toBeNull();
  });

  it("stopper feeder som er større enn grensen", async () => {
    const cfg = parseSiteConfig(
      validConfig({
        ingestion: { ...validConfig().ingestion!, maxResponseBytes: 10_000 },
        sources: [activeSource({ feedUrl: FEED })],
      }),
    );
    const big = fixture("rss2.xml").replace("Kort ingress.", "x".repeat(20_000));
    const { result } = await run(cfg, { [FEED]: xml(big) });
    expect(result).toMatchObject({ sources: [{ outcome: "failed" }] });
    expect(await db.sourceItem.count()).toBe(0);
  });

  it("isolerer feil per kilde, så de andre kildene hentes", async () => {
    const cfg = parseSiteConfig(
      validConfig({
        sources: [
          activeSource({ slug: "odelagt", feedUrl: "https://example.no/odelagt" }),
          activeSource({ slug: "fungerer", feedUrl: FEED }),
        ],
      }),
    );
    const { result } = await run(cfg, {
      ...feedOnly,
      "https://example.no/odelagt": () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(result).toMatchObject({
      status: "done",
      sources: [{ slug: "odelagt", outcome: "failed" }, { slug: "fungerer", outcome: "fetched", created: 3 }],
    });
    const broken = await db.source.findUniqueOrThrow({ where: { slug: "odelagt" } });
    expect(broken.lastFetchError).toBeTruthy();
  });

  it("henter Stortinget-saker med JSON-adapteren", async () => {
    const url = "https://data.stortinget.no/eksport/saker?format=json";
    const cfg = parseSiteConfig(
      validConfig({
        sources: [
          activeSource({
            slug: "stortinget",
            kind: "API",
            adapter: "stortinget-saker",
            feedUrl: url,
            homepageUrl: "https://data.stortinget.no/",
          }),
        ],
      }),
    );
    const { result, fake } = await run(cfg, {
      [url]: new Response(fixture("stortinget-saker.json"), { headers: { "content-type": "application/json" } }),
    });
    expect(fake.calls.find((call) => call.url === url)?.headers.accept).toBe("application/json");
    expect(result).toMatchObject({ sources: [{ outcome: "fetched", created: 1, tooOld: 1 }] });
    const item = await db.sourceItem.findFirstOrThrow();
    expect(item.url).toBe("https://www.stortinget.no/no/Saker-og-publikasjoner/Saker/Sak/?p=99001");
    expect(item.excerpt).toContain("Komité: Eksempelkomiteen");
  });

  it("lar ikke to samtidige kjøringer hente samme kilde", async () => {
    await syncSourcesFromConfig(db, config().sources);
    const fake = createFakeFetch(feedOnly);
    const [a, b] = await Promise.all([
      runIngestJob(db, { config: config(), trigger: "cron", now: NOW, fetchImpl: fake.fetchImpl }),
      runIngestJob(db, { config: config(), trigger: "manual", now: NOW, fetchImpl: fake.fetchImpl }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["done", "skipped"]);
    expect(fake.urls().filter((url) => url === FEED)).toHaveLength(1);
  });

  it("reserverer en kilde atomisk, også på tvers av prosesser", async () => {
    await syncSourcesFromConfig(db, config().sources);
    const source = await db.source.findUniqueOrThrow({ where: { slug: "testkilde" } });
    const claims = await Promise.all([
      claimSource(db, source.id, NOW, 30 * 60_000),
      claimSource(db, source.id, NOW, 30 * 60_000),
    ]);
    expect(claims.sort()).toEqual([false, true]);
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
