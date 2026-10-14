import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { type ClaudeUsage, describeClaudeError, isFatalClaudeError, SERVER_SIDE_FALLBACK_BETA } from "./claude";

export type StructuredRequest<T> = {
  model: string;
  system: string;
  user: string;
  /** JSON-skjemaet sendes uendret, så API-et håndhever enum og påkrevde felt. */
  jsonSchema: Record<string, unknown>;
  /** Tolker og validerer svaret etter at API-et har levert det. */
  parser: z.ZodType<T>;
  effort: "low" | "medium" | "high";
  maxTokens: number;
  /** Tidsgrense for dette kallet. Skriving tar lenger tid enn klassifisering. */
  timeoutMs?: number;
};

export type StructuredResult<T> = { ok: true; data: T } | { ok: false; reason: string; fatal: boolean };

/**
 * Ett kall til Claude med strukturert svar (JSON-skjema), reservemodell ved
 * avslag (server-side fallback) og telling av tokens. Feil kastes ikke; de
 * returneres som en kort, ikke-sensitiv årsak, så kalleren kan velge det
 * trygge alternativet. Tokenene telles også når svaret ikke kan brukes.
 */
export async function callStructured<T>(
  client: Anthropic,
  request: StructuredRequest<T>,
  usage: ClaudeUsage,
): Promise<StructuredResult<T>> {
  usage.calls++;
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        betas: [SERVER_SIDE_FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: request.effort, format: { type: "json_schema", schema: request.jsonSchema } },
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      },
      request.timeoutMs ? { timeout: request.timeoutMs } : undefined,
    );
  } catch (error) {
    usage.failures++;
    return { ok: false, reason: `feilet: ${describeClaudeError(error)}`, fatal: isFatalClaudeError(error) };
  }

  usage.inputTokens += response.usage.input_tokens;
  usage.outputTokens += response.usage.output_tokens;
  if (response.stop_reason !== "end_turn") {
    usage.failures++;
    return { ok: false, reason: `uten svar: stop_reason ${response.stop_reason ?? "mangler"}`, fatal: false };
  }
  // Den siste tekstblokken er svaret, også etter en overgang til reservemodellen.
  const text = response.content.findLast((block) => block.type === "text");
  let parsed: z.ZodSafeParseResult<T> | null = null;
  if (text && text.type === "text") {
    try {
      parsed = request.parser.safeParse(JSON.parse(text.text));
    } catch {
      parsed = null;
    }
  }
  if (!parsed?.success) {
    usage.failures++;
    return { ok: false, reason: "uten svar: svaret kunne ikke tolkes", fatal: false };
  }
  return { ok: true, data: parsed.data };
}

/** Gjør kildetekst om så den ikke kan lage egne tagger i meldingen til Claude. */
export function escapeTags(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}
