import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getStoriesForAdmin } from "@/lib/admin";
import type { Db } from "@/lib/db";
import { clusterConfig, insertItem, sourceIds } from "./helpers/cluster-db";
import { createTestDb } from "./helpers/test-db";

const testDb = vi.hoisted(() => ({ current: null as Db | null }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => testDb.current,
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: vi.fn(async () => undefined) }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: vi.fn(async () => undefined),
}));

const T = new Date("2026-10-10T08:00:00Z");

/** Dataene til admin-siden «Saker», mot en ekte database. */
describe("getStoriesForAdmin", () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    let db: Db;
    ({ db, cleanup } = createTestDb());
    testDb.current = db;
    const ids = await sourceIds(db, clusterConfig());
    const near = await db.story.create({ data: { slug: "flom", workingTitle: "Flom i Agder", lastSourceAt: T } });
    await db.article.create({
      data: { storyId: near.id, title: "T", lede: "L", body: "B", model: "m", promptVersion: "p" },
    });
    const own = await db.story.create({ data: { slug: "sandsekker", workingTitle: "Sandsekker", lastSourceAt: T } });
    await insertItem(db, ids.aktiv, {
      guid: "flom",
      title: "Flom i Agder",
      excerpt: "Hemmelig kildetekst",
      publishedAt: T,
    });
    await db.sourceItem.update({
      where: { sourceId_guid: { sourceId: ids.aktiv, guid: "flom" } },
      data: { storyId: near.id },
    });
    const item = await insertItem(db, ids.aktiv, { guid: "sand", title: "Sandsekker", publishedAt: T });
    await db.sourceItem.update({
      where: { id: item.id },
      data: { storyId: own.id, clusterMethod: "NEW", clusterScore: 0.3, clusterNearestStoryId: near.id },
    });
    // Ugrupperte: ett som blir gruppert, og tre som aldri blir det.
    await insertItem(db, ids.aktiv, { guid: "venter", title: "Venter", publishedAt: T });
    await insertItem(db, ids.aktiv, { guid: "tdm", title: "Reservert", publishedAt: T, tdmReserved: true });
    await insertItem(db, ids.pause, { guid: "pause", title: "Pauset kilde", publishedAt: T });
    await insertItem(db, ids.aktiv, { guid: "slettet", title: "Slettet", publishedAt: T, purgedAt: T });
  });

  afterAll(() => cleanup());

  it("teller bare elementer som faktisk blir gruppert som ventende", async () => {
    expect((await getStoriesForAdmin()).unclustered).toBe(1);
  });

  it("viser saken elementet lignet mest på, og om den har artikkel", async () => {
    const { stories } = await getStoriesForAdmin();
    const own = stories.find((s) => s.slug === "sandsekker")!;
    expect(own.article).toBeNull();
    expect(own.items[0]).toMatchObject({ clusterMethod: "NEW", clusterScore: 0.3 });
    expect(own.items[0].nearest).toMatchObject({ workingTitle: "Flom i Agder", hasArticle: true });
    expect(stories.find((s) => s.slug === "flom")!.article).toEqual({ status: "DRAFT" });
  });

  it("sender ikke kildeteksten til siden", async () => {
    expect(JSON.stringify(await getStoriesForAdmin())).not.toContain("Hemmelig kildetekst");
  });

  it("viser en gruppering som står som RUNNING, men ikke en foreldet", async () => {
    expect((await getStoriesForAdmin()).runningCluster).toBeNull();
    const db = testDb.current!;
    await db.jobRun.create({
      data: { type: "CLUSTER", trigger: "cron", startedAt: new Date(Date.now() - 3 * 3600_000) },
    });
    expect((await getStoriesForAdmin()).runningCluster).toBeNull();
    const startedAt = new Date(Date.now() - 60_000);
    await db.jobRun.create({ data: { type: "CLUSTER", trigger: "manual", startedAt } });
    expect((await getStoriesForAdmin()).runningCluster).toEqual({ startedAt, trigger: "manual" });
  });
});
