import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { checkBasicAuth } from "./basic-auth";

/**
 * Tilgangskontroll i datalaget, i tillegg til src/proxy.ts.
 *
 * Skal kalles først i hver funksjon som leser eller endrer admin-data. En
 * sjekk i layouten er ikke nok: Next rendrer sidene uavhengig av layouten, og
 * dataene deres havner i RSC-svaret selv om layouten ikke viser dem.
 */
export async function requireAdmin(): Promise<void> {
  const authorization = (await headers()).get("authorization");
  if (checkBasicAuth(authorization, process.env.ADMIN_TOKEN) !== "ok") {
    notFound();
  }
}
