import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "../db";
import { truncate } from "../ingest/text";
import { STALE_JOB_MS } from "../retention";
import { itemTime } from "./run";
import { slugify, uniqueSlug } from "./slug";

type Tx = Prisma.TransactionClient;

/** Meldingene redaktøren kan få. Siden viser teksten ut fra koden, aldri fritekst fra adressen. */
export const MANUAL_ERROR_MESSAGES = {
  "har-artikkel": "Saken har en publisert artikkel, så kildene kan ikke flyttes her.",
  "alene-i-saken": "Elementet er allerede alene i saken.",
  "samme-sak": "Elementet er allerede i den saken.",
  "ukjent-element": "Fant ikke elementet.",
  "ukjent-sak": "Fant ikke saken elementet skulle flyttes til.",
  "ikke-gruppert": "Elementet er ikke gruppert ennå.",
  "gruppering-kjorer": "Grupperingen kjører nå. Prøv igjen om litt.",
  "endret-underveis": "Elementet ble endret av noe annet i mellomtiden. Se over siden og prøv igjen.",
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
 * Saker med en artikkel som er eller har vært publisert, endres ikke her.
 * Kildene til en publisert artikkel skal bare endres gjennom
 * oppdateringsflyten (fase 5), med endringslogg. Et utkast som aldri er
 * publisert, slettes i stedet når kildene flyttes, og skrives på nytt.
 */
async function assertNoArticle(db: Db, storyId: string): Promise<void> {
  if (await hasLockedArticle(db, [storyId])) throw new ManualClusterError("har-artikkel");
}

/**
 * true hvis en av sakene har en artikkel som er eller har vært publisert.
 * Sjekkes både før og inne i transaksjonen, siden en artikkel kan bli
 * godkjent eller publisert automatisk mellom kontrollen og flyttingen.
 */
async function hasLockedArticle(tx: Tx | Db, storyIds: string[]): Promise<boolean> {
  const count = await tx.article.count({
    where: {
      storyId: { in: storyIds },
      OR: [{ publishedAt: { not: null } }, { status: { notIn: ["DRAFT", "PENDING_REVIEW"] } }],
    },
  });
  return count > 0;
}

/** Sletter utkast som aldri er publisert, så sakene skrives på nytt med de nye kildene. */
async function discardDrafts(tx: Tx, storyIds: string[]): Promise<void> {
  const deleted = await tx.article.deleteMany({
    where: { storyId: { in: storyIds }, publishedAt: null, status: { in: ["DRAFT", "PENDING_REVIEW"] } },
  });
  if (deleted.count > 0) {
    await tx.story.updateMany({
      where: { id: { in: storyIds } },
      data: { generationAttempts: 0, lastGenerationError: null, lastGenerationAt: null },
    });
  }
}

/**
 * Grupperingsjobben holder sakene i minnet mens den kjører. Endres de samtidig,
 * kan jobben lagre et tidsrom eller en sak som ikke stemmer lenger.
 */
async function assertClusteringIdle(tx: Tx | Db, now: Date): Promise<void> {
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

async function loadItem(tx: Tx | Db, itemId: string) {
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

/*
 * Alle kontroller som kan gi en forventet feil, gjøres før transaksjonen, og
 * transaksjonen selv kaster ikke ved forventede utfall. SQLite-adapteren deler
 * én tilkobling i prosessen, så en tilbakerullet transaksjon kan ta med seg
 * skrivinger fra andre oppgaver som skjedde samtidig (for eksempel at
 * grupperingsjobben markerer seg som ferdig). Endrer noen elementet mellom
 * kontrollen og skrivingen, oppdages det med en betinget oppdatering, og det
 * som allerede er skrevet, ryddes opp i samme transaksjon.
 */

/** Skiller et element ut fra saken sin, til en ny sak. Returnerer slugen til den nye saken. */
export async function detachItem(db: Db, itemId: string, now = new Date()): Promise<string> {
  await assertClusteringIdle(db, now);
  const item = await loadItem(db, itemId);
  await assertNoArticle(db, item.storyId);
  const others = await db.sourceItem.count({ where: { storyId: item.storyId, id: { not: item.id } } });
  if (others === 0) throw new ManualClusterError("alene-i-saken");

  const slug = await db.$transaction(async (tx) => {
    if (await hasLockedArticle(tx, [item.storyId])) return "har-artikkel" as const;
    const time = new Date(itemTime(item));
    const slug = await uniqueSlug(slugify(item.title), async (s) => (await tx.story.count({ where: { slug: s } })) > 0);
    const story = await tx.story.create({
      data: { slug, workingTitle: truncate(item.title, 200), firstSeenAt: time, lastSourceAt: time },
      select: { id: true },
    });
    // Den gamle saken har fortsatt elementer, så den kan brukes til å angre.
    const moved = await tx.sourceItem.updateMany({
      where: { id: item.id, storyId: item.storyId },
      data: { ...manualData(now, item.storyId), storyId: story.id },
    });
    if (moved.count === 0) {
      await tx.story.delete({ where: { id: story.id } });
      return null;
    }
    await discardDrafts(tx, [item.storyId]);
    await refreshStory(tx, item.storyId);
    return slug;
  });
  if (slug === null) throw new ManualClusterError("endret-underveis");
  if (slug === "har-artikkel") throw new ManualClusterError("har-artikkel");
  return slug;
}

/** Flytter et element til en annen sak. En sak som blir tom, slettes. */
export async function moveItem(db: Db, itemId: string, targetStoryId: string, now = new Date()): Promise<void> {
  await assertClusteringIdle(db, now);
  const item = await loadItem(db, itemId);
  if (item.storyId === targetStoryId) throw new ManualClusterError("samme-sak");
  const target = await db.story.findUnique({ where: { id: targetStoryId }, select: { id: true } });
  if (!target) throw new ManualClusterError("ukjent-sak");
  await assertNoArticle(db, item.storyId);
  await assertNoArticle(db, targetStoryId);

  const moved = await db.$transaction(async (tx) => {
    if (await hasLockedArticle(tx, [item.storyId, targetStoryId])) return "har-artikkel" as const;
    // Målsaken kan ha blitt slettet av en annen flytting siden kontrollen.
    if ((await tx.story.count({ where: { id: targetStoryId } })) === 0) return false;
    const updated = await tx.sourceItem.updateMany({
      where: { id: item.id, storyId: item.storyId },
      data: { ...manualData(now, null), storyId: targetStoryId },
    });
    if (updated.count === 0) return false;
    await discardDrafts(tx, [item.storyId, targetStoryId]);
    await refreshStory(tx, targetStoryId);
    if (await refreshStory(tx, item.storyId)) {
      await tx.sourceItem.update({ where: { id: item.id }, data: { clusterNearestStoryId: item.storyId } });
    }
    return true;
  });
  if (moved === "har-artikkel") throw new ManualClusterError("har-artikkel");
  if (!moved) throw new ManualClusterError("endret-underveis");
}

/**
 * Markerer en gruppering som står som RUNNING, som avbrutt. Brukes fra admin
 * når en kjøring har stoppet uten å bli ferdig (for eksempel ved en omstart),
 * så flytting ikke er sperret til jobben regnes som foreldet etter 90 minutter.
 * Kjører den likevel, merker den seg som ferdig når den er ferdig.
 */
export async function markClusteringAborted(db: Db, now = new Date()): Promise<number> {
  const result = await db.jobRun.updateMany({
    where: { type: "CLUSTER", status: "RUNNING" },
    data: { status: "FAILED", finishedAt: now, error: "Markert som avbrutt av redaktør" },
  });
  return result.count;
}
