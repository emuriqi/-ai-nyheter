import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "../db";
import { truncate } from "../ingest/text";
import { STALE_JOB_MS } from "../retention";
import { itemTime } from "./run";
import { slugify, uniqueSlug } from "./slug";

type Tx = Prisma.TransactionClient;

/** Meldingene redaktøren kan få. Siden viser teksten ut fra koden, aldri fritekst fra adressen. */
export const MANUAL_ERROR_MESSAGES = {
  "har-artikkel": "Saken har en artikkel, så kildene kan ikke flyttes her.",
  "alene-i-saken": "Elementet er allerede alene i saken.",
  "samme-sak": "Elementet er allerede i den saken.",
  "ukjent-element": "Fant ikke elementet.",
  "ukjent-sak": "Fant ikke saken elementet skulle flyttes til.",
  "ikke-gruppert": "Elementet er ikke gruppert ennå.",
  "gruppering-kjorer": "Grupperingen kjører nå. Prøv igjen om litt.",
  ugyldig: "Ugyldig element eller sak.",
} as const;

export type ManualErrorCode = keyof typeof MANUAL_ERROR_MESSAGES;

/** Meldingen for en kode fra adressen, eller null for alt som ikke er en kjent kode. */
export function manualErrorMessage(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(MANUAL_ERROR_MESSAGES, code)
    ? MANUAL_ERROR_MESSAGES[code as ManualErrorCode]
    : null;
}

/** Feil som vises til redaktøren. */
export class ManualClusterError extends Error {
  constructor(readonly code: ManualErrorCode) {
    super(MANUAL_ERROR_MESSAGES[code]);
  }
}

/**
 * Saker som har en artikkel, endres ikke her. Kildene til en artikkel skal
 * bare endres gjennom oppdateringsflyten (fase 5), med endringslogg.
 */
async function assertNoArticle(tx: Tx, storyId: string): Promise<void> {
  const article = await tx.article.findUnique({ where: { storyId }, select: { id: true } });
  if (article) throw new ManualClusterError("har-artikkel");
}

/**
 * Grupperingsjobben holder sakene i minnet mens den kjører. Endres de samtidig,
 * kan jobben lagre et tidsrom eller en sak som ikke stemmer lenger.
 */
async function assertClusteringIdle(tx: Tx, now: Date): Promise<void> {
  const running = await tx.jobRun.findFirst({
    where: { type: "CLUSTER", status: "RUNNING", startedAt: { gte: new Date(now.getTime() - STALE_JOB_MS) } },
    select: { id: true },
  });
  if (running) throw new ManualClusterError("gruppering-kjorer");
}

/**
 * Oppdaterer saken etter at elementer er flyttet: tidsrommet regnes fra
 * elementene, og arbeidstittel og slug følger det tidligste elementet hvis
 * elementet de kom fra, er flyttet ut. En sak uten elementer slettes.
 * Returnerer false hvis saken ble slettet.
 */
async function refreshStory(tx: Tx, storyId: string): Promise<boolean> {
  const items = await tx.sourceItem.findMany({
    where: { storyId },
    select: { title: true, publishedAt: true, fetchedAt: true },
  });
  if (items.length === 0) {
    await tx.story.delete({ where: { id: storyId } });
    return false;
  }
  const story = await tx.story.findUniqueOrThrow({ where: { id: storyId }, select: { workingTitle: true } });
  const sorted = [...items].sort((a, b) => itemTime(a) - itemTime(b));
  const data: Prisma.StoryUpdateInput = {
    firstSeenAt: new Date(itemTime(sorted[0])),
    lastSourceAt: new Date(itemTime(sorted[sorted.length - 1])),
  };
  if (!items.some((item) => truncate(item.title, 200) === story.workingTitle)) {
    // Saken har ingen artikkel (sjekket før), så slugen er ikke i bruk utad ennå.
    const title = sorted[0].title;
    data.workingTitle = truncate(title, 200);
    data.slug = await uniqueSlug(
      slugify(title),
      async (s) => (await tx.story.count({ where: { slug: s, id: { not: storyId } } })) > 0,
    );
  }
  await tx.story.update({ where: { id: storyId }, data });
  return true;
}

async function loadItem(tx: Tx, itemId: string) {
  const item = await tx.sourceItem.findUnique({
    where: { id: itemId },
    select: { id: true, title: true, storyId: true, publishedAt: true, fetchedAt: true },
  });
  if (!item) throw new ManualClusterError("ukjent-element");
  if (!item.storyId) throw new ManualClusterError("ikke-gruppert");
  return { ...item, storyId: item.storyId };
}

/**
 * Data for et element som er flyttet for hånd. `previousStoryId` er saken det
 * kom fra, hvis den fortsatt finnes; admin viser den som «Flytt tilbake».
 */
const manualData = (now: Date, previousStoryId: string | null) => ({
  clusteredAt: now,
  clusterMethod: "MANUAL" as const,
  clusterScore: null,
  clusterNote: null,
  clusterNearestStoryId: previousStoryId,
});

/** Skiller et element ut fra saken sin, til en ny sak. Returnerer slugen til den nye saken. */
export async function detachItem(db: Db, itemId: string, now = new Date()): Promise<string> {
  return db.$transaction(async (tx) => {
    await assertClusteringIdle(tx, now);
    const item = await loadItem(tx, itemId);
    await assertNoArticle(tx, item.storyId);
    const others = await tx.sourceItem.count({ where: { storyId: item.storyId, id: { not: item.id } } });
    if (others === 0) throw new ManualClusterError("alene-i-saken");

    const time = new Date(itemTime(item));
    const slug = await uniqueSlug(slugify(item.title), async (s) => (await tx.story.count({ where: { slug: s } })) > 0);
    const story = await tx.story.create({
      data: { slug, workingTitle: truncate(item.title, 200), firstSeenAt: time, lastSourceAt: time },
      select: { id: true },
    });
    // Den gamle saken har fortsatt elementer, så den kan brukes til å angre.
    await tx.sourceItem.update({
      where: { id: item.id },
      data: { ...manualData(now, item.storyId), storyId: story.id },
    });
    await refreshStory(tx, item.storyId);
    return slug;
  });
}

/** Flytter et element til en annen sak. En sak som blir tom, slettes. */
export async function moveItem(db: Db, itemId: string, targetStoryId: string, now = new Date()): Promise<void> {
  await db.$transaction(async (tx) => {
    await assertClusteringIdle(tx, now);
    const item = await loadItem(tx, itemId);
    if (item.storyId === targetStoryId) throw new ManualClusterError("samme-sak");
    const target = await tx.story.findUnique({ where: { id: targetStoryId }, select: { id: true } });
    if (!target) throw new ManualClusterError("ukjent-sak");
    await assertNoArticle(tx, item.storyId);
    await assertNoArticle(tx, targetStoryId);

    await tx.sourceItem.update({ where: { id: item.id }, data: { ...manualData(now, null), storyId: targetStoryId } });
    await refreshStory(tx, targetStoryId);
    const sourceStillExists = await refreshStory(tx, item.storyId);
    if (sourceStillExists) {
      await tx.sourceItem.update({ where: { id: item.id }, data: { clusterNearestStoryId: item.storyId } });
    }
  });
}
