import type { EditorialConfig } from "../config/schema";
import type { Finding } from "./findings";
import { checkNumbers } from "./numbers";
import { findQuotes, type Quote, withoutQuotes } from "./quotes";
import type { WrittenArticle } from "./schema";
import type { PreparedSource } from "./sources";
import { cleanText, countWords, normalizeForMatch, words } from "./text";

export { words } from "./text";
export { findQuotes } from "./quotes";
export { numbersIn } from "./numbers";

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
  // Hvert felt for seg, så et sitat eller en ordrekke ikke kan gå fra tittelen inn i ingressen.
  const quoted = fields.map((field) => ({ field, quotes: findQuotes(field) }));
  return [
    ...checkQuotes(
      quoted.flatMap((q) => q.quotes),
      sources,
      editorial,
    ),
    ...checkCopiedText(
      quoted.map(({ field, quotes }) => withoutQuotes(field, quotes, "¶")),
      sources,
      editorial.maxCopiedWords,
    ),
    ...checkNumbers(text, sources),
    ...checkSourceKeys(article, sources),
    ...checkPersons(article, text, sources, editorial.minSourcesForPersonClaims),
    ...checkUnlistedNames(fields, article),
    ...checkForm(article, text),
  ];
}

const NORWEGIAN = new Set(["nb", "nn", "no"]);

/** Der et sitat er forkortet med (…) eller […], eller har et innskudd i klammer. */
const QUOTE_BREAK = /\[[^\]]*\]|\(\s*(?:…|\.\.\.)\s*\)|…|\.\.\./u;
const INSERTION = /\[(?!\s*(?:…|\.\.\.)\s*\])[^\]]*\]/u;

/** Delene av et sitat som skal stå ordrett i kilden: alt utenom utelatelser og innskudd. */
function quoteSegments(quote: Quote): string[] {
  return quote.parts
    .flatMap((part) => part.split(new RegExp(QUOTE_BREAK, "gu")))
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);
}

/** true hvis delene står i kilden, i samme rekkefølge. */
function containsInOrder(source: string, segments: string[]): boolean {
  let from = 0;
  for (const segment of segments) {
    const needle = normalizeForMatch(segment);
    const index = source.indexOf(needle, from);
    if (index === -1) return false;
    from = index + needle.length - 1;
  }
  return true;
}

function checkQuotes(quotes: Quote[], sources: PreparedSource[], editorial: EditorialConfig): Finding[] {
  const sourceTexts = sources.map((s) => ({ source: s, text: normalizeForMatch(`${s.title}\n${s.text}`) }));
  const foreign = sources.some((s) => !NORWEGIAN.has(s.language));
  const quotedWords = new Map<string, number>();
  const findings: Finding[] = [];
  const add = (kind: string, severity: Finding["severity"], message: string, excerpt: string) =>
    findings.push({ origin: "kontroll", kind, severity, message, excerpt });

  for (const quote of quotes) {
    const segments = quoteSegments(quote);
    const count = countWords(segments.join(" "));
    if (count === 0) continue;
    if (count > editorial.maxQuoteWords) {
      add(
        "sitat_for_langt",
        "blokkerer",
        `Sitatet har ${count} ord. Grensen er ${editorial.maxQuoteWords}.`,
        quote.text,
      );
    }
    const match = sourceTexts.find((s) => containsInOrder(s.text, segments));
    if (match) {
      quotedWords.set(match.source.key, (quotedWords.get(match.source.key) ?? 0) + count);
    } else if (count < 4) {
      // Korte uttrykk i anførselstegn kan være navn eller begreper med en annen bøyning.
      add("sitat_ikke_i_kilde", "middels", "Teksten i anførselstegn står ikke ordrett i noen kilde.", quote.text);
    } else if (foreign) {
      add(
        "sitat_ikke_i_kilde",
        "høy",
        "Sitatet står ikke ordrett i noen kilde. Noen kilder er på et annet språk enn norsk; et oversatt sitat skal gjengis uten anførselstegn.",
        quote.text,
      );
    } else {
      add("sitat_ikke_i_kilde", "blokkerer", "Sitatet står ikke ordrett i noen kilde.", quote.text);
    }
    if (quote.parts.some((p) => INSERTION.test(p))) {
      add(
        "sitat_med_innskudd",
        "lav",
        "Sitatet har et innskudd i klammer. Sjekk at det ikke endrer meningen.",
        quote.text,
      );
    }
    if (quote.unclosed) {
      add(
        "sitattegn_mangler",
        "middels",
        "Sitatet mangler avsluttende anførselstegn, så det er uklart hvor det slutter.",
        quote.text,
      );
    }
  }

  for (const [key, count] of quotedWords) {
    if (count > editorial.maxQuotedWordsPerSource) {
      findings.push({
        origin: "kontroll",
        kind: "for_mye_sitert",
        severity: "høy",
        message: `Artikkelen siterer til sammen ${count} ord ordrett fra ${key}. Grensen er ${editorial.maxQuotedWordsPerSource}.`,
      });
    }
  }
  return findings;
}

/** Ordene i en tekst, både normalisert og slik de står (for å se store bokstaver). */
function tokens(text: string): { norm: string; raw: string }[] {
  return cleanText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((raw) => ({ norm: raw.toLowerCase(), raw }));
}

const NEAR_COPY_N = 4;
const NEAR_COPY_SHARE = 0.5;
const NEAR_COPY_MIN_WORDS = 15;

/**
 * Kopiert tekst utenfor sitater: ordrekker på mer enn maxCopiedWords ord som
 * er like en kilde (blokkerer), og avsnitt der minst halvparten av
 * ordrekkene på fire ord er like én kilde (nær-kopi med små endringer).
 */
function checkCopiedText(fieldsWithoutQuotes: string[], sources: PreparedSource[], maxCopiedWords: number): Finding[] {
  const n = maxCopiedWords + 1;
  const grams = new Map<string, string>();
  const sourceTitles = new Map<string, string>();
  const shortGrams = sources.map((source) => {
    const w = words(`${source.title}\n${source.text}`);
    for (let i = 0; i + n <= w.length; i++) grams.set(w.slice(i, i + n).join(" "), source.key);
    sourceTitles.set(source.key, normalizeForMatch(source.title));
    const set = new Set<string>();
    for (let i = 0; i + NEAR_COPY_N <= w.length; i++) set.add(w.slice(i, i + NEAR_COPY_N).join(" "));
    return { key: source.key, set };
  });

  const findings: Finding[] = [];
  // Hvert sitat og hvert avsnitt deler teksten, så en ordrekke ikke kan gå på tvers.
  for (const part of fieldsWithoutQuotes.flatMap((f) => f.split(/¶|\n/))) {
    const t = tokens(part);
    const w = t.map((x) => x.norm);
    let exact = false;
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
      const run = t.slice(i, end);
      const excerpt = w.slice(i, end).join(" ");
      // Navn, tall og kildens egen tittel kan ofte ikke sies med andre ord. Det vurderer redaktøren.
      const names = run.filter((x) => /^[\p{Lu}\p{N}]/u.test(x.raw)).length / run.length >= 0.7;
      const title = sourceTitles.get(key)?.includes(` ${excerpt} `) ?? false;
      findings.push({
        origin: "kontroll",
        kind: "kopiert_tekst",
        severity: names || title ? "høy" : "blokkerer",
        message:
          `${end - i} ord på rad er like ${key}. Grensen er ${maxCopiedWords} ord utenfor sitat.` +
          (names ? " Ordrekken er mest navn og tall." : title ? " Ordrekken er kildens tittel." : ""),
        excerpt,
      });
      exact = true;
      i = end;
    }

    if (exact || w.length < NEAR_COPY_MIN_WORDS) continue;
    const own: string[] = [];
    for (let j = 0; j + NEAR_COPY_N <= w.length; j++) own.push(w.slice(j, j + NEAR_COPY_N).join(" "));
    for (const source of shortGrams) {
      const share = own.filter((g) => source.set.has(g)).length / own.length;
      if (share >= NEAR_COPY_SHARE) {
        findings.push({
          origin: "kontroll",
          kind: "nesten_kopiert",
          severity: "høy",
          message: `${Math.round(share * 100)} % av ordrekkene i avsnittet er like ${source.key}. Teksten skal skrives med egne ord.`,
          excerpt: truncateWords(part, 12),
        });
        break;
      }
    }
  }
  return findings;
}

function truncateWords(text: string, max: number): string {
  const all = text.trim().split(/\s+/);
  return all.length > max ? `${all.slice(0, max).join(" ")} …` : all.join(" ");
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

/** Ordene i et navn som har stor forbokstav, for eksempel «Ola» og «Hansen» i «hydrolog Ola Hansen». */
function nameWords(name: string): string[] {
  return tokens(name)
    .filter((t) => /^\p{Lu}/u.test(t.raw))
    .map((t) => t.norm);
}

function checkPersons(article: WrittenArticle, text: string, sources: PreparedSource[], minSources: number): Finding[] {
  const articleWords = new Set(words(text));
  const sourceWords = new Map(sources.map((s) => [s.key, new Set(words(`${s.title}\n${s.text}`))]));
  const publisherOf = new Map(sources.map((s) => [s.key, s.publisher]));

  return article.personer.flatMap((person): Finding[] => {
    const name = nameWords(person.navn);
    const inText = name.length > 0 && name.every((w) => articleWords.has(w));
    if (person.rolle === "privatperson") {
      if (inText) {
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
      // Skriveren har ført opp en person uten navn, for eksempel «en mann i 40-årene».
      return [
        {
          origin: "skriver",
          kind: "privatperson_omtalt",
          severity: "middels",
          message: "Artikkelen omtaler en privatperson uten navn. Sjekk at personen ikke kan identifiseres.",
          excerpt: person.navn,
        },
      ];
    }
    // Utsagn personen gir i sin rolle, er ikke påstander om personen.
    if (person.omtale !== "påstand_om_personen") return [];
    // Bare kilder som faktisk nevner personen, og bare én per utgiver.
    const surname = name.at(-1);
    const mentioning = person.kilder.filter((k) => surname && sourceWords.get(k)?.has(surname));
    const publishers = new Set(mentioning.map((k) => publisherOf.get(k)));
    if (publishers.size < minSources) {
      return [
        {
          origin: "kontroll",
          kind: "personpåstand_med_for_få_kilder",
          severity: "middels",
          message: `Påstander om ${person.navn} har støtte i ${publishers.size} ${publishers.size === 1 ? "uavhengig kilde" : "uavhengige kilder"}. Kravet er ${minSources}.`,
          excerpt: person.navn,
        },
      ];
    }
    return [];
  });
}

/** Ord med stor forbokstav som ofte står først i en setning og ikke er navn. */
const SENTENCE_STARTERS = new Set(
  (
    "i på av for fra til med etter før under over mot om ved hos ifølge blant mens når da som der her det den de " +
    "dette disse denne en et ei og men eller også både samtidig dermed derfor likevel nå han hun vi man alle flere " +
    "mange noen ingen begge hver ny nye norske"
  ).split(" "),
);

/** Navn på institusjoner som starter med et ord i genitiv, som «Norges Bank». */
const INSTITUTION_PREFIXES = new Set(["norges", "statens"]);

/**
 * Ser etter navn som ikke står i personlisten: to eller flere ord på rad med
 * stor forbokstav, som «Kari Nilsen». Skriveren skal føre opp alle personer
 * den navngir, så et slikt funn kan være en privatperson som er oversett.
 */
function checkUnlistedNames(fields: string[], article: WrittenArticle): Finding[] {
  const listed = new Set(article.personer.flatMap((p) => nameWords(p.navn)));
  const found = new Set<string>();
  for (const field of fields) {
    for (const sentence of cleanText(field).split(/[.!?:;«»“”"–—\n()]+/)) {
      const run: string[] = [];
      const flush = () => {
        const institution = INSTITUTION_PREFIXES.has(run[0]?.toLowerCase());
        if (run.length >= 2 && !institution && !run.some((w) => listed.has(w.toLowerCase()))) found.add(run.join(" "));
        run.length = 0;
      };
      const parts = sentence.split(/(\s+)/).filter((p) => p.trim() !== "");
      parts.forEach((word, index) => {
        // Et navn: stor forbokstav, minst én liten bokstav (ikke forkortelser som NVE), ingen tegnsetting rundt.
        const clean = word.replace(/[,]$/, "");
        const isName = /^\p{Lu}[\p{Ll}]+(?:-\p{Lu}?[\p{Ll}]+)*$/u.test(clean);
        const starter = index === 0 && SENTENCE_STARTERS.has(clean.toLowerCase());
        if (isName && !starter) run.push(clean);
        else flush();
        if (clean !== word) flush();
      });
      flush();
    }
  }
  return [...found].map((name) => ({
    origin: "kontroll" as const,
    kind: "navn_utenfor_personlisten",
    severity: "middels" as const,
    message: "Dette ser ut som et navn, men står ikke i skriverens personliste. Sjekk at det ikke er en privatperson.",
    excerpt: name,
  }));
}

function checkForm(article: WrittenArticle, text: string): Finding[] {
  const findings: Finding[] = [];
  const add = (kind: string, severity: Finding["severity"], message: string, excerpt?: string) =>
    findings.push({ origin: "kontroll", kind, severity, message, excerpt });

  const link = text.match(/https?:\/\/\S+|www\.\S+/i);
  if (link) add("lenke", "høy", "Artikkelen inneholder en lenke. Lenker skal ikke skrives av Claude.", link[0]);
  const html = text.match(/<\/?[a-z][^>]*>/i);
  if (html) add("html", "høy", "Artikkelen inneholder HTML.", html[0]);

  if (article.tittel.length > 120) add("lengde", "middels", `Tittelen har ${article.tittel.length} tegn.`);
  if (article.ingress.length > 400) add("lengde", "middels", `Ingressen har ${article.ingress.length} tegn.`);
  const bodyWords = countWords(article.brodtekst);
  if (bodyWords < 30) add("lengde", "middels", `Brødteksten har bare ${bodyWords} ord.`);
  if (bodyWords > 1200) add("lengde", "middels", `Brødteksten har ${bodyWords} ord.`);
  return findings;
}

const SOURCE_REF = /\s?(?:\[|\()K\d+(?:\s*[,;/]\s*K\d+)*(?:\]|\))/g;

/**
 * Fjerner kildehenvisninger som [K1] fra teksten. De er interne nøkler og
 * skal ikke vises for leserne. Gir et funn til orientering når noe ble fjernet.
 */
export function stripSourceRefs(article: WrittenArticle): { article: WrittenArticle; findings: Finding[] } {
  const found = [article.tittel, article.ingress, article.brodtekst].flatMap((t) => t.match(SOURCE_REF) ?? []);
  if (found.length === 0) return { article, findings: [] };
  const strip = (t: string) => t.replace(SOURCE_REF, "");
  return {
    article: {
      ...article,
      tittel: strip(article.tittel),
      ingress: strip(article.ingress),
      brodtekst: strip(article.brodtekst),
    },
    findings: [
      {
        origin: "kontroll",
        kind: "kildehenvisning_i_teksten",
        severity: "lav",
        message: `Kildehenvisninger som ${found[0].trim()} er fjernet fra teksten. De vises ikke for lesere.`,
        excerpt: found[0].trim(),
      },
    ],
  };
}
