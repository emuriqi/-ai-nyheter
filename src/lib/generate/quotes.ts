/** Et direkte sitat i en tekst. */
export type Quote = {
  /** Sitatet slik det står, med delene fra flere avsnitt slått sammen. */
  text: string;
  /** Delene av sitatet. Et sitat over flere avsnitt har én del per avsnitt. */
  parts: string[];
  /** Hvor sitatet står i teksten, med sitattegnene: ett område [fra, til) per del. */
  spans: [number, number][];
  /** Sitatet mangler avsluttende sitattegn. */
  unclosed: boolean;
};

/** Andre sitattegn enn «»: åpningstegnet og tegnene som kan avslutte. */
const OTHER_MARKS: Record<string, string> = { "“": "”", "„": "“”", "‹": "›", "‘": "’", '"': '"' };

/** Et avsnitt som starter med sitatstrek: «– Vi er bekymret, sier hun.» */
const DASH_QUOTE = /^[ \t]*[–—][ \t]+/;

/** Der et sitat med sitatstrek slutter og den som siteres, nevnes. */
const ATTRIBUTION =
  /[,?!]\s+(?:[–—]\s+)?(?:sier|sa|skriver|skrev|opplyser|opplyste|forteller|fortalte|uttaler|uttalte|mener|understreker|understreket|legger til|la til|påpeker|påpekte|svarer|svarte|spør|spurte|advarer|advarte|varsler|varslet)(?![\p{L}\p{N}])/u;

/**
 * Finner direkte sitater i en tekst: alt i «», “”, „“, ‹›, ‘’ eller "", og
 * avsnitt som starter med sitatstrek (fram til «, sier …»). Følger norsk
 * skikk for sitater over flere avsnitt: hvert avsnitt starter med «, og bare
 * det siste har ».
 */
export function findQuotes(text: string): Quote[] {
  const quotes: Quote[] = [];
  let pending: Quote | null = null;
  let offset = 0;

  for (const line of text.split("\n")) {
    const at = offset;
    offset += line.length + 1;
    if (line.trim() === "") continue;
    let pos = 0;

    if (pending) {
      const lead = line.match(/^\s*«/);
      if (!lead) {
        quotes.push(pending);
        pending = null;
      } else {
        // Sitatet fortsetter i dette avsnittet.
        const open = lead[0].length - 1;
        const close = line.indexOf("»", open + 1);
        const reopen = line.indexOf("«", open + 1);
        const closed = close !== -1 && (reopen === -1 || close < reopen);
        const end = closed ? close : reopen !== -1 ? reopen : line.length;
        addPart(pending, line.slice(open + 1, end), [at + open, at + (closed ? end + 1 : end)]);
        if (closed) pending.unclosed = false;
        if (closed || reopen !== -1) {
          quotes.push(pending);
          pending = null;
          pos = closed ? end + 1 : end;
        } else {
          continue;
        }
      }
    }

    const dash = pos === 0 ? line.match(DASH_QUOTE) : null;
    if (dash) {
      const start = dash[0].length;
      const attribution = line.slice(start).search(ATTRIBUTION);
      const end = attribution === -1 ? line.length : start + attribution;
      quotes.push(quote(line.slice(start, end), [at, at + end], false));
      pos = end;
    }

    while (pos < line.length) {
      const ch = line[pos];
      if (ch === "«") {
        const close = line.indexOf("»", pos + 1);
        const reopen = line.indexOf("«", pos + 1);
        if (close !== -1 && (reopen === -1 || close < reopen)) {
          quotes.push(quote(line.slice(pos + 1, close), [at + pos, at + close + 1], false));
          pos = close + 1;
        } else if (reopen !== -1) {
          quotes.push(quote(line.slice(pos + 1, reopen), [at + pos, at + reopen], true));
          pos = reopen;
        } else {
          // Kan fortsette i neste avsnitt.
          pending = quote(line.slice(pos + 1), [at + pos, at + line.length], true);
          pos = line.length;
        }
        continue;
      }
      const closers = OTHER_MARKS[ch];
      if (closers) {
        let close = pos + 1;
        while (close < line.length && !closers.includes(line[close])) close++;
        if (close < line.length) {
          quotes.push(quote(line.slice(pos + 1, close), [at + pos, at + close + 1], false));
          pos = close + 1;
          continue;
        }
      }
      pos++;
    }
  }
  if (pending) quotes.push(pending);
  return quotes.filter((q) => q.text !== "");
}

function quote(part: string, span: [number, number], unclosed: boolean): Quote {
  const q: Quote = { text: "", parts: [], spans: [], unclosed };
  addPart(q, part, span);
  return q;
}

function addPart(q: Quote, part: string, span: [number, number]) {
  q.parts.push(part.trim());
  q.spans.push(span);
  q.text = q.parts.filter(Boolean).join(" ");
}

/** Teksten med sitatene byttet ut med skilletegnet `separator`. */
export function withoutQuotes(text: string, quotes: Quote[], separator: string): string {
  const spans = quotes.flatMap((q) => q.spans).sort((a, b) => b[0] - a[0]);
  let result = text;
  for (const [from, to] of spans) result = `${result.slice(0, from)} ${separator} ${result.slice(to)}`;
  return result;
}
