"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import {
  detachItem,
  ManualClusterError,
  type ManualErrorCode,
  markClusteringAborted,
  moveItem,
} from "@/lib/cluster/manual";
import { siteConfig } from "@/lib/config";
import {
  approveArticle,
  regenerateArticle,
  rejectArticle,
  retryStory,
  ReviewError,
  unpublishArticle,
} from "@/lib/generate/review";
import { getDb } from "@/lib/db";
import { runPipeline } from "@/lib/ingest/pipeline";

// Server actions kan kalles direkte med POST, så hver action sjekker tilgang selv.

/** Knappen «Kjør innhenting nå» i admin. */
export async function runIngestNow(): Promise<void> {
  await requireAdmin();
  await runPipeline(getDb(), { config: siteConfig, trigger: "manual" });
  refresh();
}

const idSchema = z.string().regex(/^[a-z0-9]{1,64}$/i);

function readId(formData: FormData, field: string): string | null {
  const parsed = idSchema.safeParse(formData.get(field));
  return parsed.success ? parsed.data : null;
}

/**
 * Kjører en manuell endring og går tilbake til sakssiden. Forventede feil
 * sendes som en kode (?feil=har-artikkel), som siden slår opp i en fast liste.
 * Etter en vellykket endring fjernes en eventuell gammel feilmelding fra adressen.
 */
async function runManual(change: () => Promise<unknown>): Promise<never> {
  let code: ManualErrorCode | null = null;
  try {
    await change();
  } catch (error) {
    if (!(error instanceof ManualClusterError)) throw error;
    code = error.code;
  }
  redirect(code ? `/admin/saker?feil=${code}` : "/admin/saker");
}

/** «Skill ut»: flytter et element fra saken sin til en ny sak. */
export async function detachStoryItem(formData: FormData): Promise<void> {
  await requireAdmin();
  const itemId = readId(formData, "itemId");
  if (!itemId) redirect("/admin/saker?feil=ugyldig");
  await runManual(() => detachItem(getDb(), itemId));
}

/** «Flytt»: flytter et element til en annen sak (den det lignet mest på, eller tilbake). */
export async function moveStoryItem(formData: FormData): Promise<void> {
  await requireAdmin();
  const itemId = readId(formData, "itemId");
  const storyId = readId(formData, "storyId");
  if (!itemId || !storyId) redirect("/admin/saker?feil=ugyldig");
  await runManual(() => moveItem(getDb(), itemId, storyId));
}

/** «Marker som avbrutt»: for en gruppering som står som RUNNING etter at den har stoppet. */
export async function abortClustering(): Promise<void> {
  await requireAdmin();
  await markClusteringAborted(getDb());
  redirect("/admin/saker");
}

/** Kjører en avgjørelse om en artikkel og går tilbake til godkjenningssiden med en kode for resultatet. */
async function runReview(change: () => Promise<unknown>, success: string): Promise<never> {
  let code = success;
  try {
    await change();
  } catch (error) {
    if (!(error instanceof ReviewError)) throw error;
    code = error.code;
  }
  redirect(`/admin/godkjenning?melding=${code}`);
}

function readNote(formData: FormData): string {
  const note = formData.get("note");
  return typeof note === "string" ? note : "";
}

/** «Godkjenn og publiser». */
export async function approveArticleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const articleId = readId(formData, "articleId");
  if (!articleId) redirect("/admin/godkjenning?melding=ugyldig");
  await runReview(() => approveArticle(getDb(), articleId), "publisert");
}

/** «Avvis» med begrunnelse. */
export async function rejectArticleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const articleId = readId(formData, "articleId");
  if (!articleId) redirect("/admin/godkjenning?melding=ugyldig");
  await runReview(() => rejectArticle(getDb(), articleId, readNote(formData)), "avvist");
}

/** «Skriv på nytt»: sletter et utkast som aldri er publisert. */
export async function regenerateArticleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const articleId = readId(formData, "articleId");
  if (!articleId) redirect("/admin/godkjenning?melding=ugyldig");
  await runReview(() => regenerateArticle(getDb(), articleId, { config: siteConfig }), "skrives-paa-nytt");
}

/** «Prøv igjen» for en sak der skrivingen har feilet. */
export async function retryStoryAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const storyId = readId(formData, "storyId");
  if (!storyId) redirect("/admin/godkjenning?melding=ugyldig");
  await runReview(() => retryStory(getDb(), storyId, { config: siteConfig }), "proves-igjen");
}

/** «Avpubliser» med begrunnelse. */
export async function unpublishArticleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const articleId = readId(formData, "articleId");
  if (!articleId) redirect("/admin/godkjenning?melding=ugyldig");
  await runReview(() => unpublishArticle(getDb(), articleId, readNote(formData)), "avpublisert");
}
