import { createHash, timingSafeEqual } from "node:crypto";

export const ADMIN_USER = "admin";
export const MIN_ADMIN_TOKEN_LENGTH = 12;

export type AdminAuthResult = "ok" | "disabled" | "unauthorized";

/**
 * Sjekker en «Authorization: Basic ...»-header mot ADMIN_TOKEN.
 *
 * Admin er avslått («disabled») når tokenet mangler eller er for kort, slik at
 * et tomt eller svakt passord aldri gir tilgang.
 */
export function checkBasicAuth(
  authorizationHeader: string | null | undefined,
  adminToken: string | undefined,
): AdminAuthResult {
  if (!adminToken || adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    return "disabled";
  }
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorizationHeader?.trim() ?? "");
  if (!match) {
    return "unauthorized";
  }
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return "unauthorized";
  }
  const userOk = safeEqual(decoded.slice(0, separator), ADMIN_USER);
  const passwordOk = safeEqual(decoded.slice(separator + 1), adminToken);
  return userOk && passwordOk ? "ok" : "unauthorized";
}

/** Sammenligning i konstant tid, også når lengdene er ulike. */
function safeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
