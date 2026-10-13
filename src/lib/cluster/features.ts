import { newStemmer } from "snowball-stemmers";
import { NORWEGIAN_STOPWORDS } from "./stopwords";

/**
 * Tekstegenskaper for gruppering: ordstammer vektet med TF-IDF, sammenlignet
 * med cosinuslikhet. Alt skjer lokalt; ingen tekst sendes noe sted.
 */

export type ItemText = {
  title: string;
  excerpt: string | null;
  bodyText: string | null;
};

/** Sparsom vektor: ord → vekt. */
export type TermVector = Map<string, number>;

/** Tittelen sier mest om hva saken handler om og teller dobbelt. */
const FIELD_WEIGHTS = { title: 2, excerpt: 1, body: 0.5 } as const;
/** Bare starten av brødteksten brukes. Resten er sjelden avgjørende. */
const MAX_BODY_CHARS = 2000;

const stemmer = newStemmer("norwegian");

/** «Status: », «Komité: » og lignende: ett eller to ord og kolon først på linjen. */
const FIELD_LABEL = /^\p{Lu}[\p{L}-]{1,30}(?: [\p{L}-]{1,30})?:[ \t]+/gmu;

/**
 * Fjerner ledetekster som «Status:» og «Komité:» fra faktalister. Noen kilder
 * (for eksempel Stortinget) lister fakta på den måten, og ledetekstene ville
 * ellers gjort alle elementene fra kilden like hverandre. Gjelder bare tekst
 * med minst to slike linjer, så en tittel med kolon beholdes som den er.
 */
function stripFieldLabels(text: string): string {
  const labels = text.match(FIELD_LABEL);
  return labels && labels.length >= 2 ? text.replace(FIELD_LABEL, "") : text;
}

/** Deler teksten i normaliserte ord og tall, uten stoppord, og stammer ordene. */
export function tokenize(text: string): string[] {
  const cleaned = stripFieldLabels(text.normalize("NFKC"))
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase();
  const tokens: string[] = [];
  // Desimaltall (4,6) holdes samlet. Ord med tall i (h5n1) også.
  for (const match of cleaned.matchAll(/\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{N}]+/gu)) {
    const raw = match[0];
    if (/^[\p{N}.,]+$/u.test(raw)) {
      // Enkeltsifre sier lite; desimaltall og flersifrede tall beholdes.
      if (raw.length >= 2) tokens.push(raw.replace(",", "."));
      continue;
    }
    if (raw.length < 2 || NORWEGIAN_STOPWORDS.has(raw)) continue;
    tokens.push(stemmer.stem(raw));
  }
  return tokens;
}

/**
 * Vektede ordfrekvenser for ett element (før IDF). Egennavn får ikke ekstra
 * vekt: IDF gir allerede sjeldne stedsnavn høy vekt, og ekstra vekt gjorde to
 * ulike farevarsler for samme fylke for like.
 */
export function termFrequencies(item: ItemText): TermVector {
  const tf: TermVector = new Map();
  const add = (text: string | null, weight: number) => {
    if (!text) return;
    for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + weight);
  };
  add(item.title, FIELD_WEIGHTS.title);
  add(item.excerpt, FIELD_WEIGHTS.excerpt);
  add(item.bodyText?.slice(0, MAX_BODY_CHARS) ?? null, FIELD_WEIGHTS.body);
  return tf;
}

/**
 * Dokumentfrekvenser over et referanseutvalg av elementer. Ord som står i
 * mange elementer (for eksempel «regjeringen» eller «prosent») får lav vekt.
 */
export class TermStats {
  private readonly df = new Map<string, number>();
  private docs = 0;

  constructor(documents: Iterable<TermVector> = []) {
    for (const doc of documents) this.add(doc);
  }

  add(doc: TermVector): void {
    this.docs++;
    for (const term of doc.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
  }

  get size(): number {
    return this.docs;
  }

  /** Glattet IDF: ord som ikke finnes i utvalget, regnes som sjeldne. */
  idf(term: string): number {
    return Math.log((this.docs + 1) / ((this.df.get(term) ?? 0) + 1)) + 1;
  }
}

/** TF-IDF-vektor med lengde 1, klar for cosinuslikhet. */
export function weigh(tf: TermVector, stats: TermStats): TermVector {
  const vector: TermVector = new Map();
  let sumSquares = 0;
  for (const [term, count] of tf) {
    // Sublineær frekvens: ti forekomster er ikke ti ganger så viktig som én.
    const weight = Math.log1p(count) * stats.idf(term);
    vector.set(term, weight);
    sumSquares += weight * weight;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm > 0) for (const [term, weight] of vector) vector.set(term, weight / norm);
  return vector;
}

/** Cosinuslikhet mellom to normaliserte vektorer (0 = ingen felles ord, 1 = like). */
export function cosine(a: TermVector, b: TermVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += weight * other;
  }
  // Avrundingsfeil kan gi litt over 1.
  return Math.min(1, dot);
}
