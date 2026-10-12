"use server";

import { refresh } from "next/cache";
import { requireAdmin } from "@/lib/auth/require-admin";
import { siteConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { runPipeline } from "@/lib/ingest/pipeline";

/** Knappen «Kjør innhenting nå» i admin. Sjekker tilgang selv, siden server actions kan kalles direkte. */
export async function runIngestNow(): Promise<void> {
  await requireAdmin();
  await runPipeline(getDb(), { config: siteConfig, trigger: "manual" });
  refresh();
}
