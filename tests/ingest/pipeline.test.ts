import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSiteConfig } from "@/lib/config/schema";
import type { Db } from "@/lib/db";
import { runPipeline } from "@/lib/ingest/pipeline";
import { summarizePipeline } from "@/lib/ingest/summary";
import { computeDeleteAfter, DAY_MS } from "@/lib/retention";
import { syncSourcesFromConfig } from "@/lib/sources/sync";
import { createFakeFetch, fixture, text, xml } from "../helpers/fake-fetch";
import { activeSource, validConfig } from "../helpers/fixtures";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-10-12T10:00:00Z");

/** Hele jobben slik npm run ingest, cron-ruten og admin-knappen kjører den. */
describe("runPipeline", () => {
  let db: Db;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    ({ db, cleanup } = createTestDb());
  });

  afterAll(() => cleanup());

  it("synkroniserer kildene, henter, grupperer, sletter utløpt tekst og oppsummerer på norsk", async () => {
    const config = parseSiteConfig(
      validConfig({
        retention: { sourceTextDays: 10, chatLogDays: 0, jobRunDays: 90 },
        sources: [
          activeSource({ slug: "aktiv", feedUrl: "https://example.no/rss" }),
          activeSource({ slug: "sperret", feedUrl: "https://sperret.no/rss", homepageUrl: "https://sperret.no/" }),
          activeSource({
            slug: "venter",
            status: "NEEDS_VERIFICATION",
            tdmReservation: "UNKNOWN",
            feedUrl: "https://venter.no/rss",
          }),
        ],
      }),
    );

    // Et element hentet for 20 dager siden med 60 dagers frist. Konfigurasjonen sier
    // nå 10 dager, så teksten skal slettes selv om den lagrede fristen ikke er nådd.
    await syncSourcesFromConfig(db, config.sources);
    const source = await db.source.findUniqueOrThrow({ where: { slug: "aktiv" } });
    const fetchedAt = new Date(NOW.getTime() - 20 * DAY_MS);
    await db.sourceItem.create({
      data: {
        sourceId: source.id,
        guid: "gammel",
        url: "https://example.no/gammel",
        title: "Gammel sak",
        excerpt: "Gammel tekst",
        language: "nb",
        fetchedAt,
        deleteAfter: computeDeleteAfter(fetchedAt, 60),
      },
    });

    const fake = createFakeFetch({
      "https://example.no/rss": xml(fixture("rss2.xml")),
      "https://sperret.no/robots.txt": text("User-agent: *\nDisallow: /\n"),
    });
    const result = await runPipeline(db, { config, trigger: "test", now: NOW, fetchImpl: fake.fetchImpl });

    expect(fake.urls().some((url) => url.startsWith("https://venter.no"))).toBe(false);
    const old = await db.sourceItem.findFirstOrThrow({ where: { guid: "gammel" } });
    expect(old).toMatchObject({ excerpt: null, title: "Gammel sak" });
    expect(old.purgedAt).not.toBeNull();

    const jobs = await db.jobRun.findMany({ orderBy: { type: "asc" } });
    expect(jobs.map((job) => [job.type, job.status, job.trigger])).toEqual([
      ["CLUSTER", "SUCCEEDED", "test"],
      ["INGEST", "SUCCEEDED", "test"],
      ["PURGE", "SUCCEEDED", "test"],
    ]);

    expect(summarizePipeline(result).lines).toEqual([
      "Kilder synkronisert: 0 nye, 3 oppdatert, 0 satt på pause.",
      "aktiv: hentet, 3 nye, 1 for gamle",
      "sperret: sperret, robots.txt sperrer /rss",
      "Gruppering: 4 elementer, 4 nye saker, 0 lagt til eksisterende saker, 1 usikker bør sjekkes i admin.",
      "Skriving hoppet over: Skriving er slått av i konfigurasjonen.",
      "Sletting: kildetekst fjernet fra 1 elementer, 0 gamle jobblogger slettet.",
    ]);
  });
});
