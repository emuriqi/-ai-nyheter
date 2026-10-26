import Anthropic from "@anthropic-ai/sdk";

/**
 * Lar Claude API kjøre en avvist forespørsel på nytt med en reservemodell som
 * Anthropic anbefaler for den typen avslag (server-side fallback).
 */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Hvor lenge ett kall kan ta før det avbrytes, og hvor mange nye forsøk SDK-en gjør. */
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

/** true når ANTHROPIC_API_KEY er satt. Uten nøkkel slås Claude-funksjonene av. */
export function hasClaudeKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/** Klient for Claude API, eller null hvis nøkkelen mangler. Nøkkelen leses fra miljøet, aldri fra koden. */
export function createClaudeClient(env: NodeJS.ProcessEnv = process.env): Anthropic | null {
  if (!hasClaudeKey(env)) return null;
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY!.trim(), timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
}

/** Brukes i statistikken for jobbene: antall kall og tokens. */
export type ClaudeUsage = { calls: number; failures: number; inputTokens: number; outputTokens: number };

export function emptyUsage(): ClaudeUsage {
  return { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
}

/** Kort, ikke-sensitiv beskrivelse av en feil fra API-et til logg og jobbstatistikk. */
export function describeClaudeError(error: unknown): string {
  if (error instanceof Anthropic.APIError) return `${error.constructor.name} (${error.status ?? "ingen status"})`;
  if (error instanceof Error) return error.name;
  return "ukjent feil";
}

/**
 * Feil som gjelder nøkkelen, kontoen eller oppsettet, ikke den enkelte
 * forespørselen, så det hjelper ikke å prøve igjen i samme kjøring: ugyldig
 * forespørsel (for eksempel en beta organisasjonen ikke har, eller nådd
 * forbruksgrense), feil nøkkel, brukt opp kreditt, manglende tilgang, en modell
 * som ikke finnes, og for stor forespørsel. Forespørslene bygges av koden og
 * kildeteksten er begrenset, så slike feil rammer alle saker likt.
 */
export function isFatalClaudeError(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIConnectionError) return false;
  return [400, 401, 402, 403, 404, 413].includes(error.status ?? 0);
}

/**
 * Forbigående feil hos API-et eller i nettverket: tidsavbrudd i køen (408),
 * konflikt (409), for mange kall (429), serverfeil og overbelastning (5xx) og
 * tilkoblingsfeil, også tidsavbrudd i tilkoblingen. De sier ingenting om selve
 * forespørselen.
 *
 * Unntak: når API-et selv melder tidsavbrudd under behandlingen (504), kan det
 * skyldes forespørselen (et langt svar), og det telles som et forsøk for saken.
 * Det samme gjør callStructured når et kall har brukt hele tidsgrensen.
 */
export function isTransientClaudeError(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (!(error instanceof Anthropic.APIError)) return false;
  const status = error.status ?? 0;
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status !== 504);
}
