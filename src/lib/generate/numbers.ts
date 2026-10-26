import { osloTime } from "../format";
import type { Finding } from "./findings";
import type { PreparedSource } from "./sources";
import { cleanText } from "./text";

/** Et tall, en dato eller et klokkeslett i en tekst. */
export type NumberMention = {
  kind: "tall" | "dato" | "klokkeslett";
  /**
   * Normaliserte verdier med type: «20 000» gir tall:20000, «8. oktober» gir
   * dato:8.10 og «kl. 06» gir klokkeslett:6:00. Noe kan leses på flere måter
   * («10.15» er et tall eller et klokkeslett) og har da flere.
   */
  keys: string[];
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

const ENGLISH_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
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

/** Engelske tallord, for kilder på engelsk. «One» er utelatt av samme grunn som «en». */
const ENGLISH_NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
};

const SCALES: [RegExp, number][] = [
  [/^(?:tusen|thousand)$/, 1e3],
  [/^(?:mill(?:ion|ioner|ions|\.)?|mn)$/, 1e6],
  [/^(?:milliard|milliarder|mrd\.?|billion|billions|bn)$/, 1e9],
];
const SCALE_WORDS = String.raw`tusen|thousand|millioner|million|millions|mill\.?|mn|milliarder|milliard|mrd\.?|billions|billion|bn`;

const DATE_NAMED = new RegExp(
  String.raw`(?<!\d)(\d{1,2})\.(?:\s*(?:–|-|til|og)\s*(\d{1,2})\.)?\s*(${MONTHS.join("|")})(?![\p{L}])(?:\s+(\d{4})(?!\d))?`,
  "giu",
);
const DATE_ENGLISH = new RegExp(
  String.raw`(?<!\d)(\d{1,2})\s+(${ENGLISH_MONTHS.join("|")})(?![\p{L}])(?:\s+(\d{4})(?!\d))?|(?<![\p{L}])(${ENGLISH_MONTHS.join("|")})\s+(\d{1,2})(?!\d)(?:,?\s+(\d{4})(?!\d))?`,
  "giu",
);
const DATE_NUMERIC = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?![\d])/g;
/** Dag og måned uten år, som «14.11.». */
const DATE_SHORT = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(?![\d])/g;
const TIME = /\b(?:kl\.?|klokka|klokken)\s*(\d{1,2})(?:[.:](\d{2}))?(?!\d)|(?<![\d.:,])(\d{1,2}):(\d{2})(?!\d)/giu;
const YEAR_RANGE = /(?<!\d)(19|20)(\d{2})\s*[/–-]\s*(\d{2})(?!\d)/g;
const ONE_SCALE = new RegExp(
  String.raw`(?<![\p{L}])(?:en|ett|én|one|a)\s+(million|milliard|billion)(?![\p{L}])`,
  "giu",
);
const NUMBER = new RegExp(
  String.raw`(?<![\p{L}\d.,])(\d{1,3}(?:[   ]\d{3})+(?!\d)|\d{1,3}(?:\.\d{3})+(?![\d,]|\.\d)|\d{1,3}(?:,\d{3})+(?![\d.]|,\d)|\d+(?:[.,]\d+)?)` +
    String.raw`(?:\s*(${SCALE_WORDS})(?![\p{L}]))?`,
  "giu",
);

/** Hvem teksten er fra: en kilde (med språk) eller artikkelen, som er på bokmål. */
export type TextRole = { role: "kilde"; language: string } | { role: "artikkel" };

const NORWEGIAN = new Set(["nb", "nn", "no"]);

/**
 * Et tall som tekst, normalisert: «20 000» blir 20000, «3.250» blir 3250 og
 * «4,60» blir 4.6. I engelsk tekst er «4,600» tusenskille (4600).
 */
function canonical(raw: string, english: boolean): string {
  const compact = raw.replace(/[\s\u00A0\u202F]/g, "");
  let value: number;
  if (/^\d{1,3}(?:\.\d{3})+$/.test(compact) && !english) value = Number(compact.replace(/\./g, ""));
  // Flere komma («2,300,000») er tusenskille også i norsk tekst; ett komma er desimaltegn.
  else if (/^\d{1,3}(?:,\d{3}){2,}$/.test(compact) || (english && /^\d{1,3}(?:,\d{3})+$/.test(compact))) {
    value = Number(compact.replace(/,/g, ""));
  } else value = Number(english ? compact.replace(/,/g, "") : compact.replace(",", "."));
  // Ukjente skrivemåter sammenlignes som de står, så to ulike tall aldri blir like.
  return Number.isFinite(value) ? String(value) : compact;
}

const dateKey = (day: number, month: number) => `dato:${day}.${month}`;
const validDate = (day: number, month: number) => day >= 1 && day <= 31 && month >= 1 && month <= 12;

/**
 * Finner tall, datoer og klokkeslett i en tekst. Datoer og klokkeslett
 * normaliseres, så «8. oktober», «08.10.2026» og «kl. 06» kan sammenlignes
 * med «klokken 06:00». Tallord som «tre» tas med i norsk tekst (og «three» i
 * engelsk). I artikkelen må et tall med skalaord («3 milliarder») stå med
 * samme størrelse i en kilde; i kildene regnes både «3» og 3 000 000 000 som kjent.
 */
export function numberMentions(input: string, from: TextRole = { role: "artikkel" }): NumberMention[] {
  const english = from.role === "kilde" && from.language === "en";
  const norwegian = from.role === "artikkel" || NORWEGIAN.has(from.language);
  const found: NumberMention[] = [];
  let text = cleanText(input).replace(/\bK\d+\b/g, " ");
  const take = (re: RegExp, toMentions: (m: RegExpMatchArray) => NumberMention[]) => {
    for (const m of text.matchAll(re)) found.push(...toMentions(m));
    text = text.replace(re, " ¦ ");
  };
  const date = (day: number, month: number, excerpt: string): NumberMention => ({
    kind: "dato",
    keys: [dateKey(day, month)],
    excerpt,
  });
  const year = (y: string): NumberMention => ({ kind: "tall", keys: [`tall:${Number(y)}`], excerpt: y });

  take(DATE_NAMED, (m) => {
    const month = MONTHS.indexOf(m[3].toLowerCase()) + 1;
    return [
      date(Number(m[1]), month, m[0].trim()),
      ...(m[2] ? [date(Number(m[2]), month, m[0].trim())] : []),
      ...(m[4] ? [year(m[4])] : []),
    ];
  });
  if (english) {
    take(DATE_ENGLISH, (m) => {
      const month = ENGLISH_MONTHS.indexOf((m[2] ?? m[4]).toLowerCase()) + 1;
      const y = m[3] ?? m[6];
      return [date(Number(m[1] ?? m[5]), month, m[0].trim()), ...(y ? [year(y)] : [])];
    });
  }
  take(DATE_NUMERIC, (m) => [date(Number(m[1]), Number(m[2]), m[0]), year(m[3].length === 2 ? `20${m[3]}` : m[3])]);
  take(TIME, (m) => {
    const hour = Number(m[1] ?? m[3]);
    const minute = m[2] ?? m[4] ?? "00";
    return [{ kind: "klokkeslett", keys: [`klokkeslett:${hour}:${minute}`], excerpt: m[0].trim() }];
  });
  take(DATE_SHORT, (m) => {
    const [day, month] = [Number(m[1]), Number(m[2])];
    // «14.11.» er en dato uten år, et desimaltall på slutten av en setning, eller et klokkeslett.
    // I artikkelen er en gyldig dato bare en dato; i kildene godtas også desimaltallet.
    const keys = validDate(day, month) ? [dateKey(day, month)] : [];
    if (!validDate(day, month) || from.role === "kilde") keys.push(`tall:${Number(`${m[1]}.${m[2]}`)}`);
    if (day < 24 && month < 60 && m[2].length === 2) keys.push(`klokkeslett:${day}:${m[2]}`);
    return [{ kind: validDate(day, month) ? "dato" : "tall", keys, excerpt: m[0] }];
  });
  take(YEAR_RANGE, (m) => [
    { kind: "tall", keys: [`tall:${m[1]}${m[2]}`], excerpt: m[0] },
    { kind: "tall", keys: [`tall:${m[1]}${m[3]}`], excerpt: m[0] },
  ]);
  take(ONE_SCALE, (m) => {
    const scale = /^milliard|^billion/i.test(m[1]) ? 1e9 : 1e6;
    return [{ kind: "tall", keys: [`tall:${scale}`], excerpt: m[0].trim() }];
  });
  const scaleWords = norwegian ? NUMBER_WORDS : english ? ENGLISH_NUMBER_WORDS : null;
  if (scaleWords) {
    // Tallord med skalaord: «fem milliarder», «three million».
    const wordScale = new RegExp(
      String.raw`(?<![\p{L}])(${Object.keys(scaleWords).join("|")})\s+(${SCALE_WORDS})(?![\p{L}])`,
      "giu",
    );
    take(wordScale, (m) => {
      const value = scaleWords[m[1].toLowerCase()];
      const scale = SCALES.find(([re]) => re.test(m[2].toLowerCase()))?.[1] ?? 1;
      const scaled = `tall:${Math.round(value * scale)}`;
      const keys = from.role === "artikkel" ? [scaled] : [`tall:${value}`, scaled];
      return [{ kind: "tall", keys, excerpt: m[0].trim() }];
    });
  }
  take(NUMBER, (m) => {
    const value = canonical(m[1], english);
    const scale = m[2] ? SCALES.find(([re]) => re.test(m[2].toLowerCase()))?.[1] : undefined;
    const scaled = scale && /^[\d.]+$/.test(value) ? `tall:${Math.round(Number(value) * scale)}` : null;
    // I artikkelen teller bare tallet med riktig størrelse. I kildene er begge kjent.
    const keys = scaled && from.role === "artikkel" ? [scaled] : [`tall:${value}`, ...(scaled ? [scaled] : [])];
    // «10.15» uten «kl.» kan være et klokkeslett.
    const time = !scale && m[1].match(/^([01]?\d|2[0-3])[.:]([0-5]\d)$/);
    if (time) keys.push(`klokkeslett:${Number(time[1])}:${time[2]}`);
    return [{ kind: "tall", keys, excerpt: m[0].trim() }];
  });

  const words = norwegian ? NUMBER_WORDS : english ? ENGLISH_NUMBER_WORDS : null;
  if (words) {
    for (const m of text.matchAll(/\p{L}+/gu)) {
      const word = m[0].toLowerCase();
      const value = words[word];
      if (value === undefined) continue;
      // «tre i kraft» og «et tre» er ikke tallet 3.
      if (word === "tre") {
        const before = text
          .slice(0, m.index)
          .match(/(\p{L}+)\s*$/u)?.[1]
          ?.toLowerCase();
        const after = text.slice((m.index ?? 0) + m[0].length);
        if (/^\s+i\s+kraft(?![\p{L}])/iu.test(after) || before === "et" || before === "ett") continue;
      }
      found.push({ kind: "tall", keys: [`tall:${value}`], excerpt: m[0] });
    }
  }
  return found;
}

/** Bare tallverdiene i en tekst (fra artikkelen). Brukes i testene. */
export function numbersIn(text: string, from: TextRole = { role: "artikkel" }): string[] {
  return numberMentions(text, from).flatMap((m) =>
    m.kind === "tall" ? m.keys.filter((k) => k.startsWith("tall:")).map((k) => k.slice(5)) : [],
  );
}

/** Datoen `days` kalenderdager fra `date`, i norsk tid. Ikke ±24 timer, som blir feil når sommertiden skifter. */
function osloDayOffset(date: Date, days: number): { day: number; month: number; year: number } {
  const t = osloTime(date);
  const shifted = new Date(Date.UTC(t.year, t.month - 1, t.day + days));
  return { day: shifted.getUTCDate(), month: shifted.getUTCMonth() + 1, year: shifted.getUTCFullYear() };
}

/** Tall, datoer og klokkeslett som kan brukes i artikkelen. */
function knownValues(sources: PreparedSource[]): Set<string> {
  const known = new Set<string>();
  for (const source of sources) {
    for (const m of numberMentions(`${source.title}\n${source.text}`, { role: "kilde", language: source.language })) {
      for (const key of m.keys) known.add(key);
      // Sifrene i en dato eller et klokkeslett står også i kilden.
      const [first] = m.keys;
      if (m.kind === "dato") known.add(`tall:${first.slice(5).split(".")[0]}`);
      if (m.kind === "klokkeslett") known.add(`tall:${first.slice(12).split(":")[0]}`);
    }
    // Publiseringstidspunktet står i meldingen til Claude. Relative tidsord som
    // «i dag», «i går» og «i morgen» kan regnes om til dato ut fra det.
    for (const days of [-1, 0, 1]) {
      const d = osloDayOffset(source.publishedAt, days);
      known.add(dateKey(d.day, d.month));
      known.add(`år:${d.year}`);
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
    m.keys.some((k) => known.has(k) || (/^tall:(19|20)\d{2}$/.test(k) && known.has(`år:${k.slice(5)}`)));
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const m of numberMentions(text)) {
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
