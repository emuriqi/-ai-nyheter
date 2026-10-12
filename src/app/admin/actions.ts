"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { detachItem, ManualClusterError, moveItem } from "@/lib/cluster/manual";
import { siteConfig } from "@/lib/config";
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

/** Kjører en manuell endring og gjør forventede feil om til en melding på siden. */
async function runManual(change: () => Promise<unknown>): Promise<void> {
  let message: string | null = null;
  try {
    await change();
  } catch (error) {
    if (!(error instanceof ManualClusterError)) throw error;
    message = error.message;
  }
  if (message) redirect(`/admin/saker?feil=${encodeURIComponent(message)}`);
  refresh();
}

/** «Skill ut»: flytter et element fra saken sin til en ny sak. */
export async function detachStoryItem(formData: FormData): Promise<void> {
  await requireAdmin();
  const itemId = readId(formData, "itemId");
  if (!itemId) redirect(`/admin/saker?feil=${encodeURIComponent("Ugyldig element.")}`);
  await runManual(() => detachItem(getDb(), itemId));
}

/** «Flytt dit»: flytter et element til saken det lignet mest på. */
export async function moveStoryItem(formData: FormData): Promise<void> {
  await requireAdmin();
  const itemId = readId(formData, "itemId");
  const storyId = readId(formData, "storyId");
  if (!itemId || !storyId) redirect(`/admin/saker?feil=${encodeURIComponent("Ugyldig element eller sak.")}`);
  await runManual(() => moveItem(getDb(), itemId, storyId));
}
