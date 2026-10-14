import Anthropic from "@anthropic-ai/sdk";

export type CapturedRequest = { url: string; headers: Headers; body: Record<string, unknown>; timeout?: number };

/**
 * En ekte Anthropic-klient med falskt nettverkslag: forespørselen bygges av
 * SDK-en akkurat som mot API-et, men ingenting sendes ut. `respond` får
 * forespørselen og gir svaret.
 */
export function fakeAnthropic(respond: (request: CapturedRequest) => Response) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    requests.push(request);
    return respond(request);
  };
  const client = new Anthropic({ apiKey: "test-nokkel", fetch: fetchImpl as typeof fetch, maxRetries: 0 });
  return { client, requests };
}

/** Et svar fra Messages API. */
export function messageResponse(content: unknown[], stop_reason = "end_turn", tokens = { input: 1000, output: 400 }) {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: tokens.input, output_tokens: tokens.output },
  });
}

/** Et strukturert svar (JSON i en tekstblokk). */
export function jsonResponse(data: unknown, stop_reason = "end_turn") {
  return messageResponse([{ type: "text", text: JSON.stringify(data), citations: null }], stop_reason);
}
