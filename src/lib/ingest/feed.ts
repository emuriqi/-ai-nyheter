import { XMLParser } from "fast-xml-parser";
import { htmlToText } from "./text";

/** Ett element fra en kilde, normalisert på tvers av formater. All tekst er ren tekst. */
export type FeedItem = {
  guid: string;
  url: string;
  title: string;
  publishedAt: Date | null;
  /** Kort beskrivelse fra feeden. */
  summary: string | null;
  /** Hele teksten hvis feeden har den (f.eks. content:encoded). */
  content: string | null;
};

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

/** Leser RSS 2.0, RSS 1.0 (RDF) og Atom. */
export function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  // Egendefinerte entiteter brukes i angrep som «billion laughs» og trengs aldri i feeder.
  if (/<!ENTITY/i.test(xml)) {
    throw new FeedParseError("Feeden inneholder ENTITY-deklarasjoner og avvises");
  }
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml);
  } catch (error) {
    throw new FeedParseError(`Ugyldig XML: ${error instanceof Error ? error.message : error}`);
  }

  const rss = get(doc, "rss", "channel");
  const rdf = get(doc, "rdf:RDF");
  const atom = get(doc, "feed");

  let raw: unknown[];
  if (rss) raw = asArray(get(rss, "item"));
  else if (rdf) raw = asArray(get(rdf, "item"));
  else if (atom) raw = asArray(get(atom, "entry"));
  else throw new FeedParseError("Ukjent feed-format (verken RSS eller Atom)");

  const isAtom = !rss && !rdf;
  return raw.flatMap((entry) => {
    const item = isAtom ? normalizeAtom(entry, feedUrl) : normalizeRss(entry, feedUrl);
    return item ? [item] : [];
  });
}

function normalizeRss(entry: unknown, feedUrl: string): FeedItem | null {
  const url = resolveUrl(text(get(entry, "link")), feedUrl);
  const title = htmlToText(text(get(entry, "title")));
  if (!url || !title) return null;
  const guid = text(get(entry, "guid")) || text(get(entry, "@_rdf:about")) || url;
  const published = text(get(entry, "pubDate")) || text(get(entry, "dc:date"));
  return {
    guid,
    url,
    title,
    publishedAt: parseDate(published),
    summary: nonEmpty(htmlToText(text(get(entry, "description")))),
    content: nonEmpty(htmlToText(text(get(entry, "content:encoded")))),
  };
}

function normalizeAtom(entry: unknown, feedUrl: string): FeedItem | null {
  const links = asArray(get(entry, "link"));
  const alternate =
    links.find((link) => {
      const rel = text(get(link, "@_rel"));
      return rel === "" || rel === "alternate";
    }) ?? links[0];
  const url = resolveUrl(text(get(alternate, "@_href")), feedUrl);
  const title = htmlToText(text(get(entry, "title")));
  if (!url || !title) return null;
  return {
    guid: text(get(entry, "id")) || url,
    url,
    title,
    publishedAt: parseDate(text(get(entry, "published")) || text(get(entry, "updated"))),
    summary: nonEmpty(htmlToText(text(get(entry, "summary")))),
    content: nonEmpty(htmlToText(text(get(entry, "content")))),
  };
}

/** Dato fra RFC 822 (RSS) eller ISO 8601 (Atom). Ugyldige datoer blir null. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function resolveUrl(value: string, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function get(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Tekstinnholdet i en node, uansett om parseren ga streng, tall eller objekt. */
function text(value: unknown): string {
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null && "#text" in value) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return "";
}

function nonEmpty(value: string): string | null {
  return value.length > 0 ? value : null;
}
