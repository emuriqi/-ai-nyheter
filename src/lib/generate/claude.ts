import type Anthropic from "@anthropic-ai/sdk";
import { type ClaudeUsage, emptyUsage } from "../ai/claude";
import { loadPrompt } from "../ai/prompts";
import { callStructured } from "../ai/structured";
import { escapeTags } from "../ai/structured";
import type { EditorialConfig } from "../config/schema";
import { formatLongDateTime } from "../format";
import {
  articleJsonSchema,
  articleParser,
  CATEGORIES,
  moderationJsonSchema,
  moderationParser,
  type ModerationOutput,
  type WrittenArticle,
} from "./schema";
import { formatSources, type PreparedSource } from "./sources";

/** Tenking teller med i max_tokens, så det er god plass til både tenking og svar. */
const MAX_TOKENS = 16_000;
/** Skriving og kontroll tar lenger tid enn klassifisering. */
export const TIMEOUT_MS = 5 * 60_000;
/**
 * Ett nytt forsøk i SDK-en ved forbigående feil. Med tidsgrensen over tar ett
 * kall høyst rundt ti minutter; går det fortsatt galt, prøves saken i neste kjøring.
 */
export const MAX_RETRIES = 1;

/**
 * `stopRun`: feilen gjelder API-et eller nøkkelen, ikke saken. Kjøringen
 * stopper, og forsøket telles ikke mot saken.
 */
export type WriteOutcome = { ok: true; article: WrittenArticle } | { ok: false; reason: string; stopRun: boolean };
export type ModerateOutcome = { ok: true; result: ModerationOutput } | { ok: false; reason: string; stopRun: boolean };

/** Skriver artikler. Byttes ut med en falsk i testene. */
export type ArticleWriter = {
  write(sources: PreparedSource[], now: Date): Promise<WriteOutcome>;
  usage: ClaudeUsage;
  promptVersion: string;
  model: string;
};

/** Kontrollerer artikler mot kildene. Byttes ut med en falsk i testene. */
export type ArticleModerator = {
  moderate(sources: PreparedSource[], article: WrittenArticle, now: Date): Promise<ModerateOutcome>;
  usage: ClaudeUsage;
  promptVersion: string;
  model: string;
};

function promptVars(editorial: EditorialConfig) {
  return {
    maxQuoteWords: editorial.maxQuoteWords,
    maxQuotedWordsPerSource: editorial.maxQuotedWordsPerSource,
    minSourcesForPersonClaims: editorial.minSourcesForPersonClaims,
    sensitiveCategories: editorial.sensitiveCategories.join(", "),
    categories: CATEGORIES.join(", "),
  };
}

/**
 * Claude som skriver. Etter en feil med nøkkel eller tilgang gjøres ingen
 * flere kall i samme kjøring.
 */
export function createClaudeWriter(client: Anthropic, model: string, editorial: EditorialConfig): ArticleWriter {
  const prompt = loadPrompt("article-write", promptVars(editorial));
  const usage = emptyUsage();
  const jsonSchema = articleJsonSchema(editorial);
  const parser = articleParser(editorial);
  let disabled: string | null = null;

  return {
    usage,
    model,
    promptVersion: prompt.version,
    async write(sources, now) {
      if (disabled) return { ok: false, reason: disabled, stopRun: true };
      const result = await callStructured(
        client,
        {
          model,
          system: prompt.text,
          user: `${timeContext(now)}\n\n${formatSources(sources)}\n\nSkriv artikkelen om saken i kildene over.`,
          jsonSchema,
          parser,
          effort: "medium",
          maxTokens: MAX_TOKENS,
          timeoutMs: TIMEOUT_MS,
          maxRetries: MAX_RETRIES,
        },
        usage,
      );
      if (!result.ok) {
        if (result.fatal) disabled = `Skriving ${result.reason}`;
        return { ok: false, reason: `Skriving ${result.reason}`, stopRun: result.fatal || result.transient };
      }
      return { ok: true, article: result.data };
    },
  };
}

/** Når artikkelen skrives, så relative tidsord i kildene kan regnes om. */
export function timeContext(now: Date): string {
  return `<tidspunkt>Artikkelen skrives ${formatLongDateTime(now)} (norsk tid).</tidspunkt>`;
}

/** Artikkelen slik moderatoren ser den. */
export function formatArticle(article: WrittenArticle): string {
  return `<artikkel>\nTittel: ${escapeTags(article.tittel)}\n\nIngress: ${escapeTags(article.ingress)}\n\n${escapeTags(article.brodtekst)}\n</artikkel>`;
}

/** Claude som kontrollerer artikkelen mot kildene, i et eget kall med egen prompt. */
export function createClaudeModerator(client: Anthropic, model: string, editorial: EditorialConfig): ArticleModerator {
  const prompt = loadPrompt("article-moderate", promptVars(editorial));
  const usage = emptyUsage();
  const jsonSchema = moderationJsonSchema(editorial);
  const parser = moderationParser(editorial);
  let disabled: string | null = null;

  return {
    usage,
    model,
    promptVersion: prompt.version,
    async moderate(sources, article, now) {
      if (disabled) return { ok: false, reason: disabled, stopRun: true };
      const result = await callStructured(
        client,
        {
          model,
          system: prompt.text,
          user: `${timeContext(now)}\n\n${formatSources(sources)}\n\n${formatArticle(article)}\n\nKontroller artikkelen mot kildene.`,
          jsonSchema,
          parser,
          effort: "medium",
          maxTokens: MAX_TOKENS,
          timeoutMs: TIMEOUT_MS,
          maxRetries: MAX_RETRIES,
        },
        usage,
      );
      if (!result.ok) {
        if (result.fatal) disabled = `Moderering ${result.reason}`;
        return { ok: false, reason: `Moderering ${result.reason}`, stopRun: result.fatal || result.transient };
      }
      return { ok: true, result: result.data };
    },
  };
}
