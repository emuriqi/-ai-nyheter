import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detachItem, ManualClusterError, moveItem } from "@/lib/cluster/manual";
import type { Db } from "@/lib/db";
import { clusterConfig, insertItem, sourceIds } from "../helpers/cluster-db";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-10-12T10:00:00Z");
const T1 = new Date("2026-10-07T08:00:00Z");
const T2 = new Date("2026-10-07T12:00:00Z");
const T3 = new Date("2026-10-08T09:00:00Z");

describe("manuell flytting av elementer", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  let ids: Record<string, string>;

  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    const { aktiv } = await sourceIds(db, clusterConfig());
    const a = await insertItem(db, aktiv, { guid: "a", title: "Flom i Agder", publishedAt: T1 });
    const b = await insertItem(db, aktiv, { guid: "b", title: "Sandsekker i Kristiansand", publishedAt: T2 });
    const c = await insertItem(db, aktiv, { guid: "c", title: "Snøfokk i Finnmark", publishedAt: T3 });
    const flom = await db.story.create({
      data: { slug: "flom-i-agder", workingTitle: "Flom i Agder", firstSeenAt: T1, lastSourceAt: T2 },
    });
    const sno = await db.story.create({
      data: { slug: "snofokk", workingTitle: "Snøfokk i Finnmark", firstSeenAt: T3, lastSourceAt: T3 },
    });
    await db.sourceItem.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { storyId: flom.id, clusterMethod: "AUTO" },
    });
    await db.sourceItem.update({ where: { id: c.id }, data: { storyId: sno.id, clusterMethod: "NEW" } });
    ids = { a: a.id, b: b.id, c: c.id, flom: flom.id, sno: sno.id };
  });

  afterEach(() => cleanup());

  it("skiller ut et element til en ny sak og oppdaterer tidsrommet til den gamle", async () => {
    const slug = await detachItem(db, ids.b, NOW);
    expect(slug).toBe("sandsekker-i-kristiansand");

    const b = await db.sourceItem.findUniqueOrThrow({ where: { id: ids.b }, include: { story: true } });
    expect(b).toMatchObject({ clusterMethod: "MANUAL", clusteredAt: NOW, clusterScore: null });
    expect(b.story).toMatchObject({ slug, firstSeenAt: T2, lastSourceAt: T2 });
    expect(await db.story.findUniqueOrThrow({ where: { id: ids.flom } })).toMatchObject({
      firstSeenAt: T1,
      lastSourceAt: T1,
    });
  });

  it("skiller ikke ut et element som er alene i saken", async () => {
    await expect(detachItem(db, ids.c, NOW)).rejects.toThrow(
      new ManualClusterError("Elementet er allerede alene i saken."),
    );
  });

  it("flytter et element til en annen sak og sletter saken som ble tom", async () => {
    await moveItem(db, ids.c, ids.flom, NOW);
    expect(await db.story.findUnique({ where: { id: ids.sno } })).toBeNull();
    const flom = await db.story.findUniqueOrThrow({ where: { id: ids.flom }, include: { items: true } });
    expect(flom.items).toHaveLength(3);
    expect(flom).toMatchObject({ firstSeenAt: T1, lastSourceAt: T3 });
    expect(await db.sourceItem.findUniqueOrThrow({ where: { id: ids.c } })).toMatchObject({ clusterMethod: "MANUAL" });
  });

  it("endrer ikke saker som har en artikkel", async () => {
    await db.article.create({
      data: { storyId: ids.flom, title: "T", lede: "L", body: "B", model: "m", promptVersion: "p" },
    });
    await expect(detachItem(db, ids.b, NOW)).rejects.toThrow(ManualClusterError);
    await expect(moveItem(db, ids.c, ids.flom, NOW)).rejects.toThrow(ManualClusterError);
    await expect(moveItem(db, ids.a, ids.sno, NOW)).rejects.toThrow(ManualClusterError);
    expect(await db.sourceItem.count({ where: { storyId: ids.flom } })).toBe(2);
  });

  it("avviser ukjente elementer og saker", async () => {
    await expect(moveItem(db, ids.a, "finnesikke", NOW)).rejects.toThrow("Fant ikke saken");
    await expect(detachItem(db, "finnesikke", NOW)).rejects.toThrow("Fant ikke elementet.");
    await expect(moveItem(db, ids.a, ids.flom, NOW)).rejects.toThrow("allerede i den saken");
  });
});
