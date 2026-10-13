import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runClusterJob } from "@/lib/cluster/run";
import { parseSiteConfig } from "@/lib/config/schema";
import type { Db } from "@/lib/db";
import { runPipeline } from "@/lib/ingest/pipeline";
import { runIngestJob } from "@/lib/ingest/run";
import { summarizePipeline } from "@/lib/ingest/summary";
import { computeDeleteAfter, DAY_MS } from "@/lib/retention";
import { syncSourcesFromConfig } from "@/lib/sources/sync";
import { validConfig } from "../helpers/fixtures";
import { createTestDb } from "../helpers/test-db";

vi.mock("@/lib/cluster/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cluster/run")>()),
  runClusterJob: vi.fn(),
}));
vi.mock("@/lib/ingest/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest/run")>()),
  runIngestJob: vi.fn(),
}));

const NOW = new Date("2026-10-12T10:00:00Z");
const config = parseSiteConfig(validConfig());

/**
 * Sletting av kildetekst etter sletteperioden er et juridisk krav, så den skal
 * kjøre selv om innhentingen eller grupperingen feiler.
 */
describe("runPipeline når et steg feiler", () => {
  let db: Db;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    ({ db, cleanup } = createTestDb());
  });
  afterAll(() => cleanup());

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runClusterJob).mockClear();
    await syncSourcesFromConfig(db, config.sources);
    const source = await db.source.findFirstOrThrow();
    const fetchedAt = new Date(NOW.getTime() - 40 * DAY_MS);
    await db.sourceItem.deleteMany();
    await db.jobRun.deleteMany();
    await db.sourceItem.create({
      data: {
        sourceId: source.id,
        guid: "utlopt",
        url: "https://example.no/utlopt",
        title: "Utløpt",
        excerpt: "Tekst som skal slettes",
        language: "nb",
        fetchedAt,
        deleteAfter: computeDeleteAfter(fetchedAt, 30),
      },
    });
  });

  it("sletter utløpt tekst og melder feilen når grupperingen feiler", async () => {
    vi.mocked(runIngestJob).mockResolvedValueOnce({ status: "done", jobId: "x", sources: [] });
    vi.mocked(runClusterJob).mockRejectedValueOnce(new Error("disken er full"));

    const result = await runPipeline(db, { config, trigger: "test", now: NOW });

    expect(result.cluster).toEqual({ status: "failed", reason: "disken er full" });
    expect(await db.sourceItem.findFirstOrThrow({ where: { guid: "utlopt" } })).toMatchObject({ excerpt: null });
    expect(summarizePipeline(result).lines).toContain(
      "Gruppering feilet: disken er full. Elementene grupperes i neste kjøring.",
    );
  });

  it("sletter utløpt tekst før feilen fra innhentingen kastes videre", async () => {
    vi.mocked(runIngestJob).mockRejectedValueOnce(new Error("databasen er låst"));

    await expect(runPipeline(db, { config, trigger: "test", now: NOW })).rejects.toThrow("databasen er låst");

    expect(await db.sourceItem.findFirstOrThrow({ where: { guid: "utlopt" } })).toMatchObject({ excerpt: null });
    expect(runClusterJob).not.toHaveBeenCalled();
    expect(await db.jobRun.findMany({ select: { type: true, status: true } })).toEqual([
      { type: "PURGE", status: "SUCCEEDED" },
    ]);
  });
});
