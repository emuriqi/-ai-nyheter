import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detachItem, markClusteringAborted, moveItem } from "@/lib/cluster/manual";
import type { Db } from "@/lib/db";
import { clusterConfig, insertItem, sourceIds } from "../helpers/cluster-db";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-10-12T10:00:00Z");
const T1 = new Date("2026-10-07T08:00:00Z");
const T2 = new Date("2026-10-07T12:00:00Z");
const T3 = new Date("2026-10-08T09:00:00Z");

const code = (c: string) => expect.objectContaining({ code: c });

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
      data: { slug: "snofokk-i-finnmark", workingTitle: "Snøfokk i Finnmark", firstSeenAt: T3, lastSourceAt: T3 },
    });
    await db.sourceItem.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { storyId: flom.id, clusterMethod: "AUTO", clusterScore: 0.6 },
    });
    await db.sourceItem.update({
      where: { id: c.id },
      data: {
        storyId: sno.id,
        clusterMethod: "NEW",
        clusterScore: 0.2,
        clusterNote: "x",
        clusterNearestStoryId: flom.id,
      },
    });
    ids = { a: a.id, b: b.id, c: c.id, flom: flom.id, sno: sno.id };
  });

  afterEach(() => cleanup());

  it("skiller ut et element til en ny sak, oppdaterer den gamle og husker hvor det kom fra", async () => {
    const slug = await detachItem(db, ids.b, NOW);
    expect(slug).toBe("sandsekker-i-kristiansand");

    const b = await db.sourceItem.findUniqueOrThrow({ where: { id: ids.b }, include: { story: true } });
    expect(b).toMatchObject({
      clusterMethod: "MANUAL",
      clusteredAt: NOW,
      clusterScore: null,
      clusterNote: null,
      clusterNearestStoryId: ids.flom,
    });
    expect(b.story).toMatchObject({ slug, firstSeenAt: T2, lastSourceAt: T2 });
    expect(await db.story.findUniqueOrThrow({ where: { id: ids.flom } })).toMatchObject({
      firstSeenAt: T1,
      lastSourceAt: T1,
      workingTitle: "Flom i Agder",
    });
  });

  it("gir saken som blir igjen, tittel og slug fra det tidligste elementet når kilden til tittelen flyttes ut", async () => {
    await detachItem(db, ids.a, NOW);
    expect(await db.story.findUniqueOrThrow({ where: { id: ids.flom } })).toMatchObject({
      workingTitle: "Sandsekker i Kristiansand",
      slug: "sandsekker-i-kristiansand",
      firstSeenAt: T2,
    });
    // Elementet som ble skilt ut, fikk en ny sak med sin egen tittel.
    const a = await db.sourceItem.findUniqueOrThrow({ where: { id: ids.a }, include: { story: true } });
    expect(a.story).toMatchObject({ workingTitle: "Flom i Agder", slug: "flom-i-agder-2" });
  });

  it("skiller ikke ut et element som er alene i saken", async () => {
    await expect(detachItem(db, ids.c, NOW)).rejects.toEqual(code("alene-i-saken"));
  });

  it("flytter et element til en annen sak og sletter saken som ble tom", async () => {
    await moveItem(db, ids.c, ids.flom, NOW);
    expect(await db.story.findUnique({ where: { id: ids.sno } })).toBeNull();
    const flom = await db.story.findUniqueOrThrow({ where: { id: ids.flom }, include: { items: true } });
    expect(flom.items).toHaveLength(3);
    expect(flom).toMatchObject({ firstSeenAt: T1, lastSourceAt: T3, workingTitle: "Flom i Agder" });
    // Saken det kom fra, finnes ikke lenger, så det er ingenting å angre til.
    expect(await db.sourceItem.findUniqueOrThrow({ where: { id: ids.c } })).toMatchObject({
      clusterMethod: "MANUAL",
      clusterScore: null,
      clusterNote: null,
      clusterNearestStoryId: null,
    });
  });

  it("kan angre en flytting", async () => {
    await moveItem(db, ids.b, ids.sno, NOW);
    const moved = await db.sourceItem.findUniqueOrThrow({ where: { id: ids.b } });
    expect(moved).toMatchObject({ storyId: ids.sno, clusterNearestStoryId: ids.flom });

    await moveItem(db, ids.b, moved.clusterNearestStoryId!, NOW);
    expect(await db.sourceItem.findUniqueOrThrow({ where: { id: ids.b } })).toMatchObject({
      storyId: ids.flom,
      clusterNearestStoryId: ids.sno,
    });
  });

  it("endrer ikke saker som har en artikkel", async () => {
    await db.article.create({
      data: { storyId: ids.flom, title: "T", lede: "L", body: "B", model: "m", promptVersion: "p" },
    });
    await expect(detachItem(db, ids.b, NOW)).rejects.toEqual(code("har-artikkel"));
    await expect(moveItem(db, ids.c, ids.flom, NOW)).rejects.toEqual(code("har-artikkel"));
    await expect(moveItem(db, ids.a, ids.sno, NOW)).rejects.toEqual(code("har-artikkel"));
    expect(await db.sourceItem.count({ where: { storyId: ids.flom } })).toBe(2);
  });

  it("endrer ingenting mens grupperingen kjører", async () => {
    await db.jobRun.create({ data: { type: "CLUSTER", trigger: "cron", startedAt: new Date(NOW.getTime() - 60_000) } });
    await expect(detachItem(db, ids.b, NOW)).rejects.toEqual(code("gruppering-kjorer"));
    await expect(moveItem(db, ids.c, ids.flom, NOW)).rejects.toEqual(code("gruppering-kjorer"));
    // En gammel jobb som ble hengende, blokkerer ikke.
    await db.jobRun.updateMany({ data: { startedAt: new Date(NOW.getTime() - 24 * 3600_000) } });
    await expect(moveItem(db, ids.c, ids.flom, NOW)).resolves.toBeUndefined();
  });

  it("åpner ingen transaksjon når kontrollene avviser endringen", async () => {
    await db.jobRun.create({ data: { type: "CLUSTER", trigger: "cron", startedAt: new Date(NOW.getTime() - 60_000) } });
    const transaction = vi.spyOn(db, "$transaction");
    await expect(moveItem(db, ids.c, ids.flom, NOW)).rejects.toEqual(code("gruppering-kjorer"));
    await expect(detachItem(db, ids.b, NOW)).rejects.toEqual(code("gruppering-kjorer"));
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it.each([
    ["skill ut", () => detachItem(db, ids.b, NOW)],
    ["flytt", () => moveItem(db, ids.b, ids.sno, NOW)],
  ])("%s: oppdager at elementet ble flyttet av noe annet mellom kontroll og skriving", async (_name, change) => {
    const original = db.$transaction.bind(db) as (fn: unknown) => Promise<unknown>;
    const other = await db.story.create({ data: { slug: "annen", workingTitle: "Annen" } });
    vi.spyOn(db, "$transaction").mockImplementationOnce((async (fn: unknown) => {
      await db.sourceItem.update({ where: { id: ids.b }, data: { storyId: other.id } });
      return original(fn);
    }) as never);
    const storiesBefore = await db.story.count();

    await expect(change()).rejects.toEqual(code("endret-underveis"));

    // Ingenting er endret av forsøket: ingen ny sak, og elementet ble der det ble flyttet.
    expect(await db.story.count()).toBe(storiesBefore);
    expect(await db.sourceItem.findUniqueOrThrow({ where: { id: ids.b } })).toMatchObject({
      storyId: other.id,
      clusterMethod: "AUTO",
    });
    vi.restoreAllMocks();
  });

  it("kan markere en gruppering som har stoppet, som avbrutt", async () => {
    await db.jobRun.create({ data: { type: "CLUSTER", trigger: "cron", startedAt: new Date(NOW.getTime() - 60_000) } });
    expect(await markClusteringAborted(db, NOW)).toBe(1);
    expect(await db.jobRun.findFirstOrThrow({ where: { type: "CLUSTER" } })).toMatchObject({
      status: "FAILED",
      error: "Markert som avbrutt av redaktør",
    });
    await expect(moveItem(db, ids.c, ids.flom, NOW)).resolves.toBeUndefined();
  });

  it("avviser ukjente elementer og saker med kode", async () => {
    await expect(moveItem(db, ids.a, "finnesikke", NOW)).rejects.toEqual(code("ukjent-sak"));
    await expect(detachItem(db, "finnesikke", NOW)).rejects.toEqual(code("ukjent-element"));
    await expect(moveItem(db, ids.a, ids.flom, NOW)).rejects.toEqual(code("samme-sak"));
    const { aktiv } = await sourceIds(db, clusterConfig());
    const loose = await insertItem(db, aktiv, { guid: "løs", title: "Ikke gruppert", publishedAt: T3 });
    await expect(detachItem(db, loose.id, NOW)).rejects.toEqual(code("ikke-gruppert"));
  });
});
