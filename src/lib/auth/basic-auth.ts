import { createHash, timingSafeEqual } from "node:crypto";

export const ADMIN_USER = "admin";
export const MIN_ADMIN_TOKEN_LENGTH = 24;
const MIN_DISTINCT_CHARACTERS = 8;

export type AdminAuthResult = "ok" | "disabled" | "unauthorized";

/**
 * Sjekker en «Authorization: Basic ...»-header mot ADMIN_TOKEN.
 *
 * Admin er avslått («disabled») når tokenet mangler, er for kort eller har for
 * få ulike tegn, slik at et tomt eller svakt passord aldri gir tilgang.
 * Brukernavnet er kjent, så tokenet må være tilfeldig (se .env.example).
 */
export function checkBasicAuth(
  authorizationHeader: string | null | undefined,
  adminToken: string | undefined,
): AdminAuthResult {
  if (!isStrongToken(adminToken)) {
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

export function isStrongToken(token: string | undefined): token is string {
  return (
    token !== undefined &&
    token.trim().length >= MIN_ADMIN_TOKEN_LENGTH &&
    new Set(token).size >= MIN_DISTINCT_CHARACTERS
  );
}

/** Sammenligning i konstant tid, også når lengdene er ulike. */
function safeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
