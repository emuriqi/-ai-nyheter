/** Myk bindestrek og tegn uten bredde, som kan stå inne i ord i kildetekst fra HTML. */
const INVISIBLE = /[­​-‍⁠﻿]/g;

/** Tekst uten usynlige tegn, normalisert så like tegn sammenlignes likt. */
export function cleanText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "");
}

/** Ord i en tekst: små bokstaver, uten tegnsetting. Brukes til sammenligning. */
export function words(text: string): string[] {
  return cleanText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Tekst normalisert for sammenligning: bare ord, med ett mellomrom imellom og rundt. */
export function normalizeForMatch(text: string): string {
  return ` ${words(text).join(" ")} `;
}

/**
 * Antall ord slik en leser teller dem: ord adskilt med mellomrom. «60–90»,
 * «4,6», «20 000» og «covid-19» er ett ord hver.
 */
export function countWords(text: string): number {
  return cleanText(text)
    .replace(/(\d)[\s  ](?=\d{3}(?!\d))/g, "$1")
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}
