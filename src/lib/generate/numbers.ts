import { osloTime } from "../format";
import type { Finding } from "./findings";
import type { PreparedSource } from "./sources";
import { cleanText } from "./text";

/** Et tall, en dato eller et klokkeslett i en tekst. */
export type NumberMention = {
  kind: "tall" | "dato" | "klokkeslett";
  /** Normaliserte verdier: «20 000» gir 20000, «1,2 millioner» gir 1.2 og 1200000. */
  values: string[];
  /** Slik det står i teksten. */
  excerpt: string;
};

const MONTHS = [
  "januar",
  "februar",
  "mars",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "desember",
];

/** Tallord som brukes i norsk nyhetsspråk. «En», «ett» og «ei» er utelatt, fordi de oftest er artikler. */
const NUMBER_WORDS: Record<string, number> = {
  to: 2,
  tre: 3,
  fire: 4,
  fem: 5,
  seks: 6,
  sju: 7,
  syv: 7,
  åtte: 8,
  ni: 9,
  ti: 10,
  elleve: 11,
  tolv: 12,
  tretten: 13,
  fjorten: 14,
  femten: 15,
  seksten: 16,
  sytten: 17,
  atten: 18,
  nitten: 19,
  tjue: 20,
  tretti: 30,
  førti: 40,
  femti: 50,
  seksti: 60,
  sytti: 70,
  åtti: 80,
  nitti: 90,
  hundre: 100,
  tusen: 1000,
};

const SCALES: [RegExp, number][] = [
  [/^tusen$/, 1e3],
  [/^mill(?:ion|ioner|\.)?$/, 1e6],
  [/^(?:milliard|milliarder|mrd\.?)$/, 1e9],
];

const DATE_NAMED = new RegExp(
  String.raw`(?<!\d)(\d{1,2})\.(?:\s*(?:–|-|til|og)\s*(\d{1,2})\.)?\s*(${MONTHS.join("|")})(?![\p{L}])(?:\s+(\d{4})(?!\d))?`,
  "giu",
);
const DATE_NUMERIC = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?![\d])/g;
const TIME = /\b(?:kl\.?|klokken)\s*(\d{1,2})(?:[.:](\d{2}))?(?!\d)|(?<![\d.:])(\d{1,2}):(\d{2})(?!\d)/giu;
const YEAR_RANGE = /(?<!\d)(19|20)(\d{2})\s*[/–-]\s*(\d{2})(?!\d)/g;
const NUMBER = new RegExp(
  String.raw`(?<![\p{L}\d.,])(\d{1,3}(?:[   ]\d{3})+(?!\d)|\d{1,3}(?:\.\d{3})+(?![\d,]|\.\d)|\d+(?:[.,]\d+)?)` +
    String.raw`(?:\s*(tusen|millioner|million|mill\.?|milliarder|milliard|mrd\.?)(?![\p{L}]))?`,
  "giu",
);

/** Et tall som tekst, normalisert: «20 000» blir 20000, «3.250» blir 3250 og «4,60» blir 4.6. */
function canonical(raw: string): number {
  const compact = raw.replace(/[\s  ]/g, "");
  return Number(/^\d{1,3}(?:\.\d{3})+$/.test(compact) ? compact.replace(/\./g, "") : compact.replace(",", "."));
}

/**
 * Finner tall, datoer og klokkeslett i en tekst. Datoer og klokkeslett
 * normaliseres, så «8. oktober», «08.10.2026» og «kl. 06» kan sammenlignes
 * med «klokken 06:00». Tallord som «tre» tas med når `numberWords` er sann.
 */
export function numberMentions(input: string, numberWords: boolean): NumberMention[] {
  const found: NumberMention[] = [];
  let text = cleanText(input).replace(/\bK\d+\b/g, " ");
  const take = (re: RegExp, toMentions: (m: RegExpMatchArray) => NumberMention[]) => {
    for (const m of text.matchAll(re)) found.push(...toMentions(m));
    text = text.replace(re, " ¦ ");
  };
  const date = (day: string, month: number, excerpt: string): NumberMention => ({
    kind: "dato",
    values: [`${Number(day)}.${month}`],
    excerpt,
  });
  const year = (y: string): NumberMention => ({ kind: "tall", values: [String(Number(y))], excerpt: y });

  take(DATE_NAMED, (m) => {
    const month = MONTHS.indexOf(m[3].toLowerCase()) + 1;
    return [
      date(m[1], month, m[0].trim()),
      ...(m[2] ? [date(m[2], month, m[0].trim())] : []),
      ...(m[4] ? [year(m[4])] : []),
    ];
  });
  take(DATE_NUMERIC, (m) => [date(m[1], Number(m[2]), m[0]), year(m[3].length === 2 ? `20${m[3]}` : m[3])]);
  take(TIME, (m) => {
    const hour = Number(m[1] ?? m[3]);
    const minute = m[2] ?? m[4] ?? "00";
    return [{ kind: "klokkeslett", values: [`${hour}:${minute}`], excerpt: m[0].trim() }];
  });
  take(YEAR_RANGE, (m) => [
    { kind: "tall", values: [`${m[1]}${m[2]}`], excerpt: m[0] },
    { kind: "tall", values: [`${m[1]}${m[3]}`], excerpt: m[0] },
  ]);
  take(NUMBER, (m) => {
    const value = canonical(m[1]);
    const scale = m[2] ? SCALES.find(([re]) => re.test(m[2].toLowerCase()))?.[1] : undefined;
    const values = [String(value)];
    if (scale) values.push(String(Math.round(value * scale)));
    return [{ kind: "tall", values, excerpt: m[0].trim() }];
  });
  if (numberWords) {
    for (const m of text.matchAll(/\p{L}+/gu)) {
      const value = NUMBER_WORDS[m[0].toLowerCase()];
      if (value !== undefined) found.push({ kind: "tall", values: [String(value)], excerpt: m[0] });
    }
  }
  return found;
}

/** Bare tallverdiene i en tekst. Brukes i testene. */
export function numbersIn(text: string): string[] {
  return numberMentions(text, false).flatMap((m) => (m.kind === "tall" ? m.values.slice(0, 1) : []));
}

const NORWEGIAN = new Set(["nb", "nn", "no"]);

/** Tall, datoer og klokkeslett som kan brukes i artikkelen. */
function knownValues(sources: PreparedSource[]): Set<string> {
  const known = new Set<string>();
  for (const source of sources) {
    for (const m of numberMentions(`${source.title}\n${source.text}`, NORWEGIAN.has(source.language))) {
      for (const v of m.values) known.add(`${m.kind}:${v}`);
      // Sifrene i en dato eller et klokkeslett står også i kilden.
      if (m.kind === "dato") known.add(`tall:${m.values[0].split(".")[0]}`);
      if (m.kind === "klokkeslett") known.add(`tall:${m.values[0].split(":")[0]}`);
    }
    // Publiseringstidspunktet står i meldingen til Claude. Relative tidsord som
    // «i dag», «i går» og «i morgen» kan regnes om til dato ut fra det.
    for (const days of [-1, 0, 1]) {
      const t = osloTime(new Date(source.publishedAt.getTime() + days * 86_400_000));
      known.add(`dato:${t.day}.${t.month}`);
      known.add(`år:${t.year}`);
    }
    const t = osloTime(source.publishedAt);
    known.add(`klokkeslett:${t.hour}:${String(t.minute).padStart(2, "0")}`);
  }
  return known;
}

/**
 * Tall, datoer og klokkeslett i artikkelen som ikke står i kildene. Årstall
 * godtas også når de er publiseringsåret til en kilde, og datoer når de er
 * dagen før, samme dag eller dagen etter at en kilde ble publisert.
 */
export function checkNumbers(text: string, sources: PreparedSource[]): Finding[] {
  const known = knownValues(sources);
  const isKnown = (m: NumberMention) =>
    m.values.some(
      (v) => known.has(`${m.kind}:${v}`) || (m.kind === "tall" && /^(19|20)\d{2}$/.test(v) && known.has(`år:${v}`)),
    );
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const m of numberMentions(text, true)) {
    const key = m.excerpt.toLowerCase();
    if (isKnown(m) || seen.has(key)) continue;
    seen.add(key);
    findings.push({
      origin: "kontroll",
      kind: "tall_uten_kilde",
      severity: "middels",
      message:
        m.kind === "dato"
          ? `Datoen «${m.excerpt}» står ikke i kildene. Sjekk at den er riktig regnet ut.`
          : m.kind === "klokkeslett"
            ? `Klokkeslettet «${m.excerpt}» står ikke i kildene.`
            : `Tallet «${m.excerpt}» står ikke i kildene. Sjekk om det er riktig gjengitt eller utledet.`,
      excerpt: m.excerpt,
    });
  }
  return findings;
}
