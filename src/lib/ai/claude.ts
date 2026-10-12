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

/** Feil der det ikke hjelper å prøve igjen i samme kjøring (feil nøkkel eller manglende tilgang). */
export function isFatalClaudeError(error: unknown): boolean {
  return error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError;
}
