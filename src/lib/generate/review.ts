import type { Db } from "../db";
import { type Finding, isBlocking } from "./findings";

/** Meldingene redaktøren kan få. Siden viser teksten ut fra koden, aldri fritekst fra adressen. */
export const REVIEW_MESSAGES = {
  publisert: "Artikkelen er publisert.",
  avvist: "Artikkelen er avvist.",
  "skrives-paa-nytt": "Utkastet er slettet. Saken skrives på nytt ved neste kjøring.",
  avpublisert: "Artikkelen er avpublisert.",
  "ukjent-artikkel": "Fant ikke artikkelen.",
  "ikke-til-godkjenning": "Artikkelen venter ikke på godkjenning.",
  blokkert: "Artikkelen bryter faste regler og kan ikke publiseres. Avvis den, eller skriv den på nytt.",
  "mangler-begrunnelse": "Skriv en begrunnelse (høyst 500 tegn).",
  "ikke-publisert": "Artikkelen er ikke publisert.",
  "har-vaert-publisert": "Artikkelen har vært publisert og kan ikke skrives på nytt her.",
  "endret-underveis": "Artikkelen ble endret i mellomtiden. Se over siden og prøv igjen.",
  ugyldig: "Ugyldig forespørsel.",
} as const;

export type ReviewCode = keyof typeof REVIEW_MESSAGES;
export type ReviewErrorCode = Exclude<ReviewCode, "publisert" | "avvist" | "skrives-paa-nytt" | "avpublisert">;

export class ReviewError extends Error {
  constructor(readonly code: ReviewErrorCode) {
    super(REVIEW_MESSAGES[code]);
  }
}

/** Meldingen for en kode fra adressen, eller null for alt som ikke er en kjent kode. */
export function reviewMessage(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(REVIEW_MESSAGES, code) ? REVIEW_MESSAGES[code as ReviewCode] : null;
}

const MAX_NOTE_CHARS = 500;

function requireNote(note: string): string {
  const trimmed = note.trim();
  if (!trimmed || trimmed.length > MAX_NOTE_CHARS) throw new ReviewError("mangler-begrunnelse");
  return trimmed;
}

/** Artikkelen med siste versjon, kildene den bygger på og modereringen av den. */
async function loadArticle(db: Db, articleId: string) {
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      storyId: true,
      status: true,
      version: true,
      publishedAt: true,
      title: true,
      lede: true,
      body: true,
      revisions: {
        orderBy: { version: "desc" },
        take: 1,
        select: {
          id: true,
          sources: { select: { sourceItemId: true } },
          moderation: { select: { id: true, decision: true, reasons: true } },
        },
      },
    },
  });
  if (!article) throw new ReviewError("ukjent-artikkel");
  return { ...article, latest: article.revisions[0] };
}

/*
 * Kontrollene gjøres før transaksjonen, og transaksjonen kaster ikke ved
 * forventede utfall (se forklaringen i src/lib/cluster/manual.ts). En betinget
 * oppdatering oppdager om artikkelen er endret i mellomtiden.
 */

/**
 * Godkjenner og publiserer en artikkel som venter på godkjenning. Artikler med
 * brudd på faste regler (for langt eller oppdiktet sitat, kopiert tekst,
 * privatperson, ukjent kilde) kan ikke publiseres.
 */
export async function approveArticle(db: Db, articleId: string, now = new Date()): Promise<void> {
  const article = await loadArticle(db, articleId);
  const moderation = article.latest?.moderation;
  if (article.status !== "PENDING_REVIEW" || !moderation || moderation.decision !== "PENDING") {
    throw new ReviewError("ikke-til-godkjenning");
  }
  if (isBlocking((moderation.reasons as Finding[] | null) ?? [])) throw new ReviewError("blokkert");

  const done = await db.$transaction(async (tx) => {
    const updated = await tx.article.updateMany({
      where: { id: article.id, status: "PENDING_REVIEW", version: article.version },
      data: { status: "PUBLISHED", publishedAt: now },
    });
    if (updated.count === 0) return false;
    await tx.moderationReview.update({
      where: { id: moderation.id },
      data: { decision: "APPROVED", decidedBy: "ADMIN", decidedAt: now, decisionNote: "Godkjent av redaktør" },
    });
    return true;
  });
  if (!done) throw new ReviewError("endret-underveis");
}

/** Avviser en artikkel som venter på godkjenning. Den blir et utkast som ikke vises. */
export async function rejectArticle(db: Db, articleId: string, note: string, now = new Date()): Promise<void> {
  const reason = requireNote(note);
  const article = await loadArticle(db, articleId);
  const moderation = article.latest?.moderation;
  if (article.status !== "PENDING_REVIEW" || !moderation || moderation.decision !== "PENDING") {
    throw new ReviewError("ikke-til-godkjenning");
  }
  const done = await db.$transaction(async (tx) => {
    const updated = await tx.article.updateMany({
      where: { id: article.id, status: "PENDING_REVIEW", version: article.version },
      data: { status: "DRAFT" },
    });
    if (updated.count === 0) return false;
    await tx.moderationReview.update({
      where: { id: moderation.id },
      data: { decision: "REJECTED", decidedBy: "ADMIN", decidedAt: now, decisionNote: reason },
    });
    return true;
  });
  if (!done) throw new ReviewError("endret-underveis");
}

/**
 * Sletter et utkast som aldri er publisert, så saken skrives på nytt ved neste
 * kjøring. Publiserte artikler rettes i stedet med endringslogg (fase 5).
 */
export async function regenerateArticle(db: Db, articleId: string): Promise<void> {
  const article = await loadArticle(db, articleId);
  if (article.publishedAt !== null || !["DRAFT", "PENDING_REVIEW"].includes(article.status)) {
    throw new ReviewError("har-vaert-publisert");
  }
  const done = await db.$transaction(async (tx) => {
    const deleted = await tx.article.deleteMany({
      where: { id: article.id, publishedAt: null, status: { in: ["DRAFT", "PENDING_REVIEW"] } },
    });
    if (deleted.count === 0) return false;
    await tx.story.update({
      where: { id: article.storyId },
      data: { generationAttempts: 0, lastGenerationError: null },
    });
    return true;
  });
  if (!done) throw new ReviewError("endret-underveis");
}

/**
 * Avpubliserer en artikkel med begrunnelse. Teksten beholdes, og
 * avpubliseringen føres som en ny versjon i endringsloggen.
 */
export async function unpublishArticle(db: Db, articleId: string, note: string, now = new Date()): Promise<void> {
  const reason = requireNote(note);
  const article = await loadArticle(db, articleId);
  if (article.status !== "PUBLISHED") throw new ReviewError("ikke-publisert");

  const done = await db.$transaction(async (tx) => {
    const version = article.version + 1;
    const updated = await tx.article.updateMany({
      where: { id: article.id, status: "PUBLISHED", version: article.version },
      data: { status: "UNPUBLISHED", unpublishedAt: now, unpublishReason: reason, version },
    });
    if (updated.count === 0) return false;
    await tx.articleRevision.create({
      data: {
        articleId: article.id,
        version,
        type: "UNPUBLISHED",
        title: article.title,
        lede: article.lede,
        body: article.body,
        changeSummary: "Avpublisert",
        reason,
        createdBy: "ADMIN",
        createdAt: now,
        sources: { create: (article.latest?.sources ?? []).map((s) => ({ sourceItemId: s.sourceItemId })) },
      },
    });
    return true;
  });
  if (!done) throw new ReviewError("endret-underveis");
}
