import { z } from "zod";
import { FeedParseError, type FeedItem } from "./feed";

/**
 * Leser saker fra Stortingets åpne API (data.stortinget.no/eksport/saker).
 *
 * Formatet er skrevet etter Stortingets dokumentasjon og ikke kontrollert mot
 * et ekte svar ennå (utviklingsmiljøet hadde ikke tilgang). Skjemaet er derfor
 * romslig: bare id og tittel er påkrevd, og beskrivende felter godtas både
 * som tekst og tall (f.eks. statuskoder). Mangler `saker_liste`, eller kan
 * ingen saker leses, feiler innhentingen med en tydelig melding i stedet for
 * å rapportere at alt gikk bra.
 */

/** Tekst eller tall, gjort om til tekst. Alt annet blir null. */
const loose = z
  .unknown()
  .optional()
  .transform((value) => (typeof value === "string" || typeof value === "number" ? String(value) : null));

const nameSchema = z
  .unknown()
  .optional()
  .transform((value) =>
    typeof value === "object" && value !== null ? loose.parse((value as { navn?: unknown }).navn) : null,
  );

const sakSchema = z.object({
  id: z.union([z.number(), z.string().min(1)]),
  tittel: loose,
  korttittel: loose,
  sist_oppdatert_dato: loose,
  status: loose,
  type: loose,
  dokumentgruppe: loose,
  henvisning: loose,
  komite: nameSchema,
  emne_liste: z
    .unknown()
    .optional()
    .transform((value) => (Array.isArray(value) ? value.map((emne) => nameSchema.parse(emne)) : [])),
});

export const STORTINGET_SAK_URL = "https://www.stortinget.no/no/Saker-og-publikasjoner/Saker/Sak/?p=";

export function parseStortingetSaker(body: string): FeedItem[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new FeedParseError("Svaret fra Stortinget er ikke gyldig JSON");
  }
  const list = (data as { saker_liste?: unknown } | null)?.saker_liste;
  if (!Array.isArray(list)) {
    throw new FeedParseError("Uventet format fra Stortinget: mangler saker_liste");
  }

  const items = list.flatMap((raw): FeedItem[] => {
    const parsed = sakSchema.safeParse(raw);
    if (!parsed.success) return [];
    const sak = parsed.data;
    const title = (sak.tittel ?? sak.korttittel ?? "").trim();
    if (!title) return [];

    const id = String(sak.id);
    const publishedAt = parseStortingetDate(sak.sist_oppdatert_dato);
    const topics = sak.emne_liste.filter(Boolean);
    const facts = [
      sak.korttittel && sak.korttittel !== title ? `Korttittel: ${sak.korttittel}` : null,
      sak.status ? `Status: ${humanize(sak.status)}` : null,
      sak.type ? `Type: ${humanize(sak.type)}` : null,
      sak.dokumentgruppe ? `Dokumentgruppe: ${humanize(sak.dokumentgruppe)}` : null,
      sak.komite ? `Komité: ${sak.komite}` : null,
      topics.length > 0 ? `Emner: ${topics.join(", ")}` : null,
      sak.henvisning ? `Henvisning: ${sak.henvisning}` : null,
    ].filter((line): line is string => line !== null);

    return [
      {
        guid: id,
        url: `${STORTINGET_SAK_URL}${encodeURIComponent(id)}`,
        title,
        publishedAt,
        summary: facts.length > 0 ? facts.join("\n") : null,
        content: null,
      },
    ];
  });

  if (list.length > 0 && items.length === 0) {
    throw new FeedParseError(`Uventet format fra Stortinget: ingen av ${list.length} saker kunne leses`);
  }
  return items;
}

/** Stortinget bruker Microsofts JSON-datoformat «/Date(1349647200000+0200)/», men vi godtar også ISO 8601. */
export function parseStortingetDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const microsoft = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value);
  if (microsoft) return new Date(Number(microsoft[1]));
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function humanize(code: string): string {
  return code.replace(/_/g, " ");
}
