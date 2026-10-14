import type { EditorialConfig } from "../config/schema";
import type { Finding } from "./findings";
import type { WrittenArticle } from "./schema";
import type { PreparedSource } from "./sources";

/**
 * Automatiske kontroller av en artikkel mot kildene den bygger på. De er
 * enkle og forutsigbare, og fanger de vanligste feilene uavhengig av Claude:
 * sitater, kopiert tekst, tall som ikke står i kildene, ukjente kilder,
 * privatpersoner, lenker og lengde.
 */
export function checkArticle(
  article: WrittenArticle,
  sources: PreparedSource[],
  editorial: EditorialConfig,
): Finding[] {
  const fields = [article.tittel, article.ingress, article.brodtekst];
  const text = fields.join("\n\n");
  return [
    ...checkQuotes(text, sources, editorial.maxQuoteWords),
    // Hvert felt for seg, så en ordrekke ikke kan gå fra tittelen inn i ingressen.
    ...checkCopiedText(fields.join(" ¶ "), sources, editorial.maxCopiedWords),
    ...checkNumbers(text, sources),
    ...checkSourceKeys(article, sources),
    ...checkPersons(article, sources, editorial.minSourcesForPersonClaims),
    ...checkForm(article, text),
  ];
}

/** Ord i en tekst: små bokstaver, uten tegnsetting. */
export function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Tekst normalisert for sammenligning av sitater: bare ord, med ett mellomrom imellom. */
function normalizeForMatch(text: string): string {
  return ` ${words(text).join(" ")} `;
}

const QUOTE_PATTERN = /«([^«»]+)»|“([^“”]+)”|"([^"]+)"/g;

/** Direkte sitater i teksten: alt i «», “” eller "". */
export function findQuotes(text: string): string[] {
  return [...text.matchAll(QUOTE_PATTERN)].map((m) => (m[1] ?? m[2] ?? m[3]).trim()).filter(Boolean);
}

function checkQuotes(text: string, sources: PreparedSource[], maxQuoteWords: number): Finding[] {
  const sourceTexts = sources.map((s) => normalizeForMatch(`${s.title}\n${s.text}`));
  const findings: Finding[] = [];
  for (const quote of findQuotes(text)) {
    const count = words(quote).length;
    if (count > maxQuoteWords) {
      findings.push({
        origin: "kontroll",
        kind: "sitat_for_langt",
        severity: "blokkerer",
        message: `Sitatet har ${count} ord. Grensen er ${maxQuoteWords}.`,
        excerpt: quote,
      });
    }
    if (count > 0 && !sourceTexts.some((t) => t.includes(normalizeForMatch(quote)))) {
      // Korte uttrykk i «» kan være navn eller begreper med en annen bøyning.
      findings.push({
        origin: "kontroll",
        kind: "sitat_ikke_i_kilde",
        severity: count >= 4 ? "blokkerer" : "middels",
        message: "Teksten i anførselstegn står ikke ordrett i noen kilde.",
        excerpt: quote,
      });
    }
  }
  return findings;
}

/** Fjerner sitater, så ordrette sitater (som kontrolleres for seg) ikke regnes som kopiert tekst. */
function withoutQuotes(text: string): string {
  return text.replace(QUOTE_PATTERN, " ¶ ");
}

function checkCopiedText(text: string, sources: PreparedSource[], maxCopiedWords: number): Finding[] {
  // Ordrekker på mer enn maxCopiedWords ord som er like en kilde.
  const n = maxCopiedWords + 1;
  const grams = new Map<string, string>();
  for (const source of sources) {
    const w = words(`${source.title}\n${source.text}`);
    for (let i = 0; i + n <= w.length; i++) grams.set(w.slice(i, i + n).join(" "), source.key);
  }
  // Hvert sitat deler teksten, så en ordrekke ikke kan gå på tvers av et sitat.
  const findings: Finding[] = [];
  for (const part of withoutQuotes(text).split("¶")) {
    const w = words(part);
    let i = 0;
    while (i + n <= w.length) {
      const key = grams.get(w.slice(i, i + n).join(" "));
      if (!key) {
        i++;
        continue;
      }
      // Utvid treffet så langt det går, og rapporter hele ordrekken én gang.
      let end = i + n;
      while (end < w.length && grams.has(w.slice(end - n + 1, end + 1).join(" "))) end++;
      findings.push({
        origin: "kontroll",
        kind: "kopiert_tekst",
        severity: "blokkerer",
        message: `${end - i} ord på rad er like ${key}. Grensen er ${maxCopiedWords} ord utenfor sitat.`,
        excerpt: w.slice(i, end).join(" "),
      });
      i = end;
    }
  }
  return findings;
}

const NUMBER_PATTERN = /\d+(?:[   ]\d{3})*(?:[.,]\d+)?/g;

/** Tall i en tekst, normalisert: «20 000» blir 20000 og «4,6» blir 4.6. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBER_PATTERN)].map((m) =>
    m[0]
      .replace(/[   ]/g, "")
      .replace(",", ".")
      .replace(/^0+(?=\d)/, ""),
  );
}

function checkNumbers(text: string, sources: PreparedSource[]): Finding[] {
  const known = new Set<string>();
  for (const source of sources) {
    for (const n of numbersIn(`${source.title}\n${source.text}`)) known.add(n);
    // Publiseringsdatoen står i meldingen til Claude og kan brukes.
    const d = source.publishedAt;
    for (const n of [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]) known.add(String(n));
  }
  // Kildehenvisninger som [K1] er ikke tall.
  const unknown = [...new Set(numbersIn(text.replace(/\bK\d+\b/g, " ")))].filter((n) => !known.has(n));
  return unknown.map((n) => ({
    origin: "kontroll" as const,
    kind: "tall_uten_kilde",
    severity: "middels" as const,
    message: `Tallet ${n.replace(".", ",")} står ikke i kildene. Sjekk om det er riktig utledet.`,
    excerpt: n.replace(".", ","),
  }));
}

function checkSourceKeys(article: WrittenArticle, sources: PreparedSource[]): Finding[] {
  const keys = new Set(sources.map((s) => s.key));
  const findings: Finding[] = [];
  const unknown = [...article.kilder_brukt, ...article.personer.flatMap((p) => p.kilder)].filter((k) => !keys.has(k));
  if (unknown.length > 0) {
    findings.push({
      origin: "kontroll",
      kind: "ukjent_kilde",
      severity: "blokkerer",
      message: `Artikkelen viser til kilder som ikke finnes: ${[...new Set(unknown)].join(", ")}.`,
    });
  }
  if (!article.kilder_brukt.some((k) => keys.has(k))) {
    findings.push({
      origin: "kontroll",
      kind: "ingen_kilder",
      severity: "høy",
      message: "Artikkelen oppgir ikke hvilke kilder den bygger på.",
    });
  }
  return findings;
}

function checkPersons(article: WrittenArticle, sources: PreparedSource[], minSources: number): Finding[] {
  const keys = new Set(sources.map((s) => s.key));
  return article.personer.flatMap((person): Finding[] => {
    if (person.rolle === "privatperson") {
      return [
        {
          origin: "skriver",
          kind: "privatperson",
          severity: "blokkerer",
          message: "Artikkelen navngir en privatperson. Privatpersoner navngis aldri.",
          excerpt: person.navn,
        },
      ];
    }
    const count = new Set(person.kilder.filter((k) => keys.has(k))).size;
    if (count < minSources) {
      return [
        {
          origin: "kontroll",
          kind: "personpåstand_med_for_få_kilder",
          severity: "middels",
          message: `${person.navn} nevnes i ${count} ${count === 1 ? "kilde" : "kilder"}. Påstander om enkeltpersoner krever ${minSources}.`,
          excerpt: person.navn,
        },
      ];
    }
    return [];
  });
}

function checkForm(article: WrittenArticle, text: string): Finding[] {
  const findings: Finding[] = [];
  const add = (kind: string, severity: Finding["severity"], message: string, excerpt?: string) =>
    findings.push({ origin: "kontroll", kind, severity, message, excerpt });

  const link = text.match(/https?:\/\/\S+|www\.\S+/i);
  if (link) add("lenke", "høy", "Artikkelen inneholder en lenke. Lenker skal ikke skrives av Claude.", link[0]);
  const html = text.match(/<\/?[a-z][^>]*>/i);
  if (html) add("html", "høy", "Artikkelen inneholder HTML.", html[0]);
  const ref = text.match(/\[K\d+\]|\(K\d+\)/);
  if (ref)
    add(
      "kildehenvisning_i_teksten",
      "lav",
      "Teksten har kildehenvisninger som [K1]. De vises ikke for lesere.",
      ref[0],
    );

  if (article.tittel.length > 120) add("lengde", "middels", `Tittelen har ${article.tittel.length} tegn.`);
  if (article.ingress.length > 400) add("lengde", "middels", `Ingressen har ${article.ingress.length} tegn.`);
  const bodyWords = words(article.brodtekst).length;
  if (bodyWords < 40) add("lengde", "middels", `Brødteksten har bare ${bodyWords} ord.`);
  if (bodyWords > 1200) add("lengde", "middels", `Brødteksten har ${bodyWords} ord.`);
  return findings;
}
