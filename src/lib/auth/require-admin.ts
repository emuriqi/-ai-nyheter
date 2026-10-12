import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { checkBasicAuth } from "./basic-auth";

/**
 * Andre lag av tilgangskontroll for admin, i tillegg til src/proxy.ts.
 * Kalles fra serverkomponenter og route handlers før admin-data leses.
 */
export async function requireAdmin(): Promise<void> {
  const authorization = (await headers()).get("authorization");
  if (checkBasicAuth(authorization, process.env.ADMIN_TOKEN) !== "ok") {
    notFound();
  }
}
