import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import {
  type ClaudeUsage,
  describeClaudeError,
  emptyUsage,
  isFatalClaudeError,
  SERVER_SIDE_FALLBACK_BETA,
} from "../ai/claude";
import { loadPrompt } from "../ai/prompts";
import { truncate } from "../ingest/text";
import type { JudgeCandidate, StoryJudge } from "./assign";
import type { ItemText } from "./features";

/** Bare tittel og et kort utdrag sendes til Claude, ikke hele teksten. */
const MAX_TEXT_CHARS = 600;
const MAX_TOKENS = 4096;

const verdictSchema = z.object({
  sak: z.enum(["A", "B", "C", "ingen"]),
  begrunnelse: z.string(),
});

/** Teksten fra kildene kan ikke lage egne tagger i meldingen til Claude. */
function escapeTags(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

function describeItem(item: ItemText): string {
  const text = item.excerpt ?? item.bodyText ?? "";
  const lines = [`Tittel: ${escapeTags(item.title)}`];
  if (text.trim()) lines.push(`Tekst: ${escapeTags(truncate(text.trim(), MAX_TEXT_CHARS))}`);
  return `<element>\n${lines.join("\n")}\n</element>`;
}

/** Meldingen Claude får: det nye elementet og kandidatsakene. */
export function buildJudgeMessage(item: ItemText, candidates: JudgeCandidate[]): string {
  const stories = candidates
    .map((c) => `<sak id="${c.key}">\n${c.items.map(describeItem).join("\n")}\n</sak>`)
    .join("\n\n");
  return `<nytt_element>\n${describeItem(item)}\n</nytt_element>\n\n<kandidatsaker>\n${stories}\n</kandidatsaker>`;
}

export type ClaudeJudge = { judge: StoryJudge; usage: ClaudeUsage; promptVersion: string };

/**
 * Lar Claude avgjøre elementer i gråsonen. Svar som ikke kan brukes (feil,
 * avslag eller ugyldig format) gir `undefined`, og elementet blir da en egen
 * sak. Etter en feil med nøkkel eller tilgang gjøres ingen flere kall.
 */
export function createClaudeJudge(client: Anthropic, model: string): ClaudeJudge {
  const prompt = loadPrompt("cluster-same-story");
  const usage = emptyUsage();
  let disabled = false;

  const judge: StoryJudge = async (item, candidates) => {
    if (disabled || candidates.length === 0) return undefined;
    usage.calls++;
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: MAX_TOKENS,
        betas: [SERVER_SIDE_FALLBACK_BETA],
        fallbacks: "default",
        // Klassifisering trenger lite resonnering.
        output_config: { effort: "low", format: betaZodOutputFormat(verdictSchema) },
        system: prompt.text,
        messages: [{ role: "user", content: buildJudgeMessage(item, candidates) }],
      });
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      const verdict = response.stop_reason === "refusal" ? null : response.parsed_output;
      if (!verdict) {
        usage.failures++;
        return undefined;
      }
      const keys = new Set(candidates.map((c) => c.key));
      if (verdict.sak !== "ingen" && !keys.has(verdict.sak)) {
        usage.failures++;
        return undefined;
      }
      return {
        match: verdict.sak === "ingen" ? null : verdict.sak,
        reason: truncate(verdict.begrunnelse.trim(), 300),
      };
    } catch (error) {
      usage.failures++;
      if (isFatalClaudeError(error)) disabled = true;
      console.warn(`Claude-vurdering feilet: ${describeClaudeError(error)}`);
      return undefined;
    }
  };

  return { judge, usage, promptVersion: prompt.version };
}
