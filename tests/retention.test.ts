import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import {
  DAY_MS,
  computeDeleteAfter,
  pruneJobRuns,
  purgeExpiredSourceText,
  runRetentionJob,
} from "@/lib/retention";
import { createTestDb } from "./helpers/test-db";

describe("computeDeleteAfter", () => {
  it("legger sletteperioden til hentetidspunktet", () => {
    const fetchedAt = new Date("2026-10-01T12:00:00Z");
    expect(computeDeleteAfter(fetchedAt, 30).toISOString()).toBe("2026-10-31T12:00:00.000Z");
  });

  it.each([0, -1, 1.5, Number.NaN])("avviser ugyldig periode %s", (days) => {
    expect(() => computeDeleteAfter(new Date(), days)).toThrow(RangeError);
  });
});

describe("sletting av kildetekst", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  let sourceId: string;
  const now = new Date("2026-10-12T00:00:00Z");

  beforeAll(async () => {
    ({ db, cleanup } = createTestDb());
    const source = await db.source.create({
      data: {
        slug: "kilde",
        name: "Kilde",
        publisher: "Utgiver",
        kind: "RSS",
        homepageUrl: "https://example.no/",
        termsUrl: "https://example.no/vilkar",
        license: "CC-BY-4.0",
        licenseNote: "Åpen",
        attribution: "Kilde",
        language: "nb",
        status: "ACTIVE",
        tdmReservation: "NONE_FOUND",
      },
    });
    sourceId = source.id;
  });

  afterAll(() => cleanup());

  beforeEach(async () => {
    await db.sourceItem.deleteMany();
    await db.jobRun.deleteMany();
  });

  function item(guid: string, fetchedDaysAgo: number, retentionDays = 30) {
    const fetchedAt = new Date(now.getTime() - fetchedDaysAgo * DAY_MS);
    return db.sourceItem.create({
      data: {
        sourceId,
        guid,
        url: `https://example.no/${guid}`,
        title: `Tittel ${guid}`,
        excerpt: "Utdrag",
        bodyText: "Brødtekst",
        contentHash: "hash",
        language: "nb",
        fetchedAt,
        deleteAfter: computeDeleteAfter(fetchedAt, retentionDays),
      },
    });
  }

  it("fjerner tekst etter sletteperioden, men beholder tittel, URL og hash", async () => {
    const expired = await item("gammel", 31);
    const fresh = await item("ny", 5);

    const { purged } = await purgeExpiredSourceText(db, { now, retentionDays: 30 });
    expect(purged).toBe(1);

    const after = await db.sourceItem.findUniqueOrThrow({ where: { id: expired.id } });
    expect(after.excerpt).toBeNull();
    expect(after.bodyText).toBeNull();
    expect(after.purgedAt?.toISOString()).toBe(now.toISOString());
    expect(after.title).toBe("Tittel gammel");
    expect(after.url).toBe("https://example.no/gammel");
    expect(after.contentHash).toBe("hash");

    const untouched = await db.sourceItem.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(untouched.bodyText).toBe("Brødtekst");
    expect(untouched.purgedAt).toBeNull();
  });

  it("teller ikke allerede slettede elementer på nytt", async () => {
    await item("gammel", 40);
    await purgeExpiredSourceText(db, { now, retentionDays: 30 });
    const second = await purgeExpiredSourceText(db, { now, retentionDays: 30 });
    expect(second.purged).toBe(0);
  });

  it("bruker en kortere sletteperiode også på tekst som allerede er lagret", async () => {
    // Hentet for 10 dager siden med 30 dagers periode, men perioden er nå 7 dager.
    await item("lagret-med-lang-periode", 10, 30);
    const { purged } = await purgeExpiredSourceText(db, { now, retentionDays: 7 });
    expect(purged).toBe(1);
  });

  it("sletter gamle, ferdige jobblogger og beholder nye og kjørende", async () => {
    const old = new Date(now.getTime() - 100 * DAY_MS);
    await db.jobRun.createMany({
      data: [
        { type: "INGEST", trigger: "cron", status: "SUCCEEDED", startedAt: old },
        { type: "INGEST", trigger: "cron", status: "RUNNING", startedAt: old },
        { type: "INGEST", trigger: "cron", status: "SUCCEEDED", startedAt: now },
      ],
    });
    const { deleted } = await pruneJobRuns(db, { now, retentionDays: 90 });
    expect(deleted).toBe(1);
    expect(await db.jobRun.count()).toBe(2);
  });

  it("logger slettejobben med statistikk", async () => {
    await item("gammel", 31);
    const stats = await runRetentionJob(db, { now, trigger: "test", sourceTextDays: 30, jobRunDays: 90 });
    expect(stats).toEqual({ purgedSourceItems: 1, deletedJobRuns: 0 });

    const job = await db.jobRun.findFirstOrThrow({ where: { type: "PURGE" } });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.stats).toEqual(stats);
  });
});
