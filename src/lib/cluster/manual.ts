import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "../db";
import { truncate } from "../ingest/text";
import { itemTime } from "./run";
import { slugify, uniqueSlug } from "./slug";

type Tx = Prisma.TransactionClient;

/** Feil som vises til redaktøren. */
export class ManualClusterError extends Error {}

/**
 * Saker som har en artikkel, endres ikke her. Kildene til en artikkel skal
 * bare endres gjennom oppdateringsflyten (fase 5), med endringslogg.
 */
async function assertNoArticle(tx: Tx, storyId: string): Promise<void> {
  const article = await tx.article.findUnique({ where: { storyId }, select: { id: true } });
  if (article) throw new ManualClusterError("Saken har en artikkel, så kildene kan ikke flyttes her.");
}

/** Oppdaterer sakens tidsrom etter elementene, eller sletter saken hvis den er tom. */
async function refreshStory(tx: Tx, storyId: string): Promise<void> {
  const items = await tx.sourceItem.findMany({ where: { storyId }, select: { publishedAt: true, fetchedAt: true } });
  if (items.length === 0) {
    await tx.story.delete({ where: { id: storyId } });
    return;
  }
  const times = items.map(itemTime);
  await tx.story.update({
    where: { id: storyId },
    data: { firstSeenAt: new Date(Math.min(...times)), lastSourceAt: new Date(Math.max(...times)) },
  });
}

async function loadItem(tx: Tx, itemId: string) {
  const item = await tx.sourceItem.findUnique({
    where: { id: itemId },
    select: { id: true, title: true, storyId: true, publishedAt: true, fetchedAt: true },
  });
  if (!item) throw new ManualClusterError("Fant ikke elementet.");
  if (!item.storyId) throw new ManualClusterError("Elementet er ikke gruppert ennå.");
  return { ...item, storyId: item.storyId };
}

const manualData = (now: Date) => ({
  clusteredAt: now,
  clusterMethod: "MANUAL" as const,
  clusterScore: null,
  clusterNote: null,
  clusterNearestStoryId: null,
});

/** Skiller et element ut fra saken sin, til en ny sak. Returnerer slugen til den nye saken. */
export async function detachItem(db: Db, itemId: string, now = new Date()): Promise<string> {
  return db.$transaction(async (tx) => {
    const item = await loadItem(tx, itemId);
    await assertNoArticle(tx, item.storyId);
    const others = await tx.sourceItem.count({ where: { storyId: item.storyId, id: { not: item.id } } });
    if (others === 0) throw new ManualClusterError("Elementet er allerede alene i saken.");

    const time = new Date(itemTime(item));
    const slug = await uniqueSlug(slugify(item.title), async (s) => (await tx.story.count({ where: { slug: s } })) > 0);
    const story = await tx.story.create({
      data: { slug, workingTitle: truncate(item.title, 200), firstSeenAt: time, lastSourceAt: time },
      select: { id: true },
    });
    await tx.sourceItem.update({ where: { id: item.id }, data: { ...manualData(now), storyId: story.id } });
    await refreshStory(tx, item.storyId);
    return slug;
  });
}

/** Flytter et element til en annen sak. En sak som blir tom, slettes. */
export async function moveItem(db: Db, itemId: string, targetStoryId: string, now = new Date()): Promise<void> {
  await db.$transaction(async (tx) => {
    const item = await loadItem(tx, itemId);
    if (item.storyId === targetStoryId) throw new ManualClusterError("Elementet er allerede i den saken.");
    const target = await tx.story.findUnique({ where: { id: targetStoryId }, select: { id: true } });
    if (!target) throw new ManualClusterError("Fant ikke saken elementet skulle flyttes til.");
    await assertNoArticle(tx, item.storyId);
    await assertNoArticle(tx, targetStoryId);

    await tx.sourceItem.update({ where: { id: item.id }, data: { ...manualData(now), storyId: targetStoryId } });
    await refreshStory(tx, targetStoryId);
    await refreshStory(tx, item.storyId);
  });
}
