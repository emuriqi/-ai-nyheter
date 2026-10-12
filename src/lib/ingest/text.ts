import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * Gjør HTML om til ren tekst. Bilder, skript og stiler fjernes, og
 * blokkelementer blir linjeskift. Bare teksten lagres, aldri HTML eller bilder.
 */
export function htmlToText(html: string): string {
  // Lagret tekst kuttes uansett til noen tusen tegn. Grensen hindrer at et
  // enormt eller dypt nøstet felt gjør tolkningen treg.
  html = html.slice(0, MAX_HTML_CHARS);
  if (!/[<&]/.test(html)) {
    return normalizeWhitespace(html);
  }
  const marked = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article)>/gi, "$&\n");
  const { document } = parseHTML(`<!doctype html><html><body>${marked}</body></html>`);
  document.querySelectorAll("script, style, noscript, img, picture, figure, svg, iframe").forEach((el) => el.remove());
  return normalizeWhitespace(document.body.textContent ?? "");
}

/**
 * Henter hovedteksten fra en artikkelside med Mozillas Readability (samme
 * motor som leservisningen i Firefox). Returnerer null hvis siden ikke ser ut
 * som en artikkel.
 */
export function extractArticleText(html: string, url: string): string | null {
  if (html.length > MAX_HTML_CHARS) return null;
  const { document } = parseHTML(html);
  // Readability bruker dokumentets URL til å løse relative lenker.
  Object.defineProperty(document, "documentURI", { value: url });
  let article: ReturnType<Readability["parse"]>;
  try {
    // Grensen hindrer at en svært stor eller dypt nøstet side låser prosessen.
    article = new Readability(document as unknown as Document, {
      charThreshold: 200,
      maxElemsToParse: MAX_ELEMENTS,
    }).parse();
  } catch {
    return null;
  }
  // Bruker HTML-en fra Readability (ikke textContent) for å beholde avsnittene.
  const text = article?.content ? htmlToText(article.content) : "";
  return text.length > 0 ? text : null;
}

/** Sider med flere elementer enn dette regnes ikke som artikler. */
const MAX_ELEMENTS = 10_000;
/** Lengste HTML som tolkes, for ett felt eller én artikkelside. */
export const MAX_HTML_CHARS = 1_000_000;

/** Slår sammen mellomrom og tomme linjer. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Kutter teksten ved nærmeste ordgrense før grensen og markerer kuttet. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Stabil hash av innholdet, brukt til å oppdage endringer. */
export function contentHash(...parts: (string | null | undefined)[]): string {
  return createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\u0000"))
    .digest("hex");
}
