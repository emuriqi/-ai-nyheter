/**
 * Funn fra kontrollene av en artikkel. Lagres i ModerationReview.reasons og
 * vises for redaktøren.
 *
 * - blokkerer: brudd på en fast regel (for langt eller oppdiktet sitat,
 *   kopiert tekst, privatperson, ukjent kilde). Artikkelen kan ikke publiseres.
 * - høy, middels: må vurderes av redaktøren. Flagger artikkelen.
 * - lav, info: til orientering.
 */
export type Severity = "blokkerer" | "høy" | "middels" | "lav" | "info";

export type FindingOrigin = "kontroll" | "moderering" | "skriver";

export type Finding = {
  origin: FindingOrigin;
  kind: string;
  severity: Severity;
  message: string;
  /** Kort utdrag fra artikkelen funnet gjelder. */
  excerpt?: string;
};

export const SEVERITY_ORDER: Severity[] = ["blokkerer", "høy", "middels", "lav", "info"];

export function isBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "blokkerer");
}

/** Funn som gjør at artikkelen må vurderes av en redaktør. */
export function isFlagging(finding: Finding): boolean {
  return finding.severity === "blokkerer" || finding.severity === "høy" || finding.severity === "middels";
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}
