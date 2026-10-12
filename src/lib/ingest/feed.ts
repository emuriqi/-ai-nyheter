import { XMLParser } from "fast-xml-parser";
import { htmlToText, normalizeWhitespace } from "./text";

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
  // Atom-tekst kan inneholde XHTML med blandet innhold. Råteksten beholdes, så
  // rekkefølgen på ordene ikke går tapt, og tolkes etter type i atomText().
  stopNodes: ["feed.entry.title", "feed.entry.summary", "feed.entry.content"],
});

/** Leser RSS 2.0, RSS 1.0 (RDF) og Atom. */
export function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  // Egendefinerte entiteter brukes i angrep som «billion laughs» og trengs aldri i feeder.
  // De kan bare deklareres i DOCTYPE før rotelementet, så bare den delen sjekkes.
  const rootStart = xml.search(/<(rss|rdf:RDF|feed)[\s>]/);
  const prolog = rootStart >= 0 ? xml.slice(0, rootStart) : xml;
  if (/<!ENTITY/i.test(prolog)) {
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
  const guidValue = decodeCharRefs(text(get(entry, "guid")));
  // I RSS 2.0 er <link> valgfri. Da er guid lenken, med mindre isPermaLink="false".
  const guidIsLink = text(get(entry, "guid", "@_isPermaLink")) !== "false" && /^https?:\/\//i.test(guidValue);
  const url =
    resolveUrl(decodeCharRefs(text(get(entry, "link"))), feedUrl) ?? (guidIsLink ? resolveUrl(guidValue, feedUrl) : null);
  const title = htmlToText(text(get(entry, "title")));
  if (!url || !title) return null;
  const guid = guidValue || decodeCharRefs(text(get(entry, "@_rdf:about"))) || url;
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
  const url = resolveUrl(decodeCharRefs(text(get(alternate, "@_href"))), feedUrl);
  const title = atomText(get(entry, "title"));
  if (!url || !title) return null;
  return {
    guid: decodeCharRefs(text(get(entry, "id"))) || url,
    url,
    title,
    publishedAt: parseDate(text(get(entry, "published")) || text(get(entry, "updated"))),
    summary: nonEmpty(atomText(get(entry, "summary"))),
    content: nonEmpty(atomText(get(entry, "content"))),
  };
}

/**
 * Atom-tekst, som parseren gir som rå XML: type="xhtml" er innebygde
 * elementer, "html" er escapet HTML, og "text" (standard) er ren tekst.
 */
function atomText(value: unknown): string {
  const type = text(get(value, "@_type"));
  const raw = text(value);
  if (type === "xhtml") return htmlToText(raw);
  if (type === "html") return htmlToText(decodeXml(raw));
  return normalizeWhitespace(decodeXml(raw));
}

/** Dekoder XML-entiteter og pakker ut CDATA i rå XML-tekst. */
function decodeXml(raw: string): string {
  let out = "";
  let position = 0;
  for (;;) {
    const start = raw.indexOf("<![CDATA[", position);
    if (start < 0) return out + decodeEntities(raw.slice(position));
    out += decodeEntities(raw.slice(position, start));
    const end = raw.indexOf("]]>", start + 9);
    if (end < 0) return out + raw.slice(start + 9);
    out += raw.slice(start + 9, end);
    position = end + 3;
  }
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return decodeCharRefs(value).replace(/&(lt|gt|amp|quot|apos);/g, (_match, name: string) => XML_ENTITIES[name]);
}

/**
 * Dekoder numeriske tegnreferanser (&#038; og &#x26;) som XML-parseren lar
 * stå i lenker og id-er. Tekstfelter dekodes senere av htmlToText.
 */
function decodeCharRefs(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (match, code: string) => {
    const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

/** Dato fra RFC 822 (RSS) eller ISO 8601 (Atom). Ugyldige datoer blir null. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  // Norske kilder bruker ofte CET/CEST, som Date.parse ikke kjenner.
  const normalized = value.replace(/\bCEST\b/, "+0200").replace(/\bCET\b/, "+0100");
  const time = Date.parse(normalized);
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
