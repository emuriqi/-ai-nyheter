// Norske visningsnavn for verdier fra databasen og konfigurasjonen.

export const SOURCE_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Aktiv",
  PAUSED: "På pause",
  NEEDS_VERIFICATION: "Må verifiseres",
};

export const LICENSE_LABEL: Record<string, string> = {
  "NLOD-2.0": "NLOD 2.0",
  "CC-BY-4.0": "CC BY 4.0",
  "CC0-1.0": "CC0 1.0",
  "PUBLIC-DOMAIN": "Fri (offentlig eiendom)",
  UNKNOWN: "Ukjent",
};

export const TDM_LABEL: Record<string, string> = {
  NONE_FOUND: "Ingen funnet",
  RESERVED: "Reservert",
  UNKNOWN: "Ikke sjekket",
};

export const ARTICLE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Utkast",
  PENDING_REVIEW: "Til godkjenning",
  PUBLISHED: "Publisert",
  UNPUBLISHED: "Avpublisert",
};

export const JOB_TYPE_LABEL: Record<string, string> = {
  INGEST: "Innhenting",
  CLUSTER: "Gruppering",
  GENERATE: "Generering",
  PURGE: "Sletting",
};

export const JOB_STATUS_LABEL: Record<string, string> = {
  RUNNING: "Kjører",
  SUCCEEDED: "Fullført",
  FAILED: "Feilet",
};

/** Kort beskrivelse av resultatet av en jobb, ut fra statistikken den lagret. */
export function describeJobStats(type: string, stats: unknown): string {
  if (typeof stats !== "object" || stats === null) return "";
  const s = stats as Record<string, unknown>;
  if (type === "PURGE") {
    return `Tekst slettet fra ${Number(s.purgedSourceItems ?? 0)} elementer`;
  }
  if (type === "INGEST" && typeof s.totals === "object" && s.totals !== null) {
    const t = s.totals as Record<string, number>;
    const sources = Array.isArray(s.sources) ? s.sources.length : 0;
    if (sources === 0) return "Ingen aktive kilder";
    return `${t.created ?? 0} nye, ${t.updated ?? 0} endret fra ${sources} ${sources === 1 ? "kilde" : "kilder"}` +
      (t.blocked ? `, ${t.blocked} sperret` : "") +
      (t.failed ? `, ${t.failed} feilet` : "");
  }
  return "";
}

export function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}
