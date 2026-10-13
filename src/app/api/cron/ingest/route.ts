import { checkBearerToken } from "@/lib/auth/basic-auth";
import { siteConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { runPipeline } from "@/lib/ingest/pipeline";
import { summarizePipeline } from "@/lib/ingest/summary";

/**
 * Kjører innhenting, gruppering og sletting. Kalles av en cron-jobb:
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<vert>/api/cron/ingest
 *
 * Ruten er avslått når CRON_SECRET mangler eller er svak.
 */
export async function POST(request: Request) {
  const auth = checkBearerToken(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth === "disabled") {
    return Response.json(
      { error: "Cron er avslått. Sett CRON_SECRET til en tilfeldig verdi på minst 24 tegn." },
      { status: 503 },
    );
  }
  if (auth !== "ok") {
    return Response.json(
      { error: "Mangler eller ugyldig token" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  const result = await runPipeline(getDb(), { config: siteConfig, trigger: "cron" });
  const { lines, ingest, cluster, retention } = summarizePipeline(result);
  // Slettingen har kjørt uansett, men en feilet gruppering skal synes i overvåkingen.
  const ok = cluster.status !== "failed";
  return Response.json({ ok, summary: lines, ingest, cluster, retention }, { status: ok ? 200 : 500 });
}
