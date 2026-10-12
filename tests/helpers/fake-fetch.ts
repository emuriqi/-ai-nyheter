import { readFileSync } from "node:fs";
import path from "node:path";
import type { FetchLike } from "@/lib/ingest/http";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");

export function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

type Handler = Response | ((init: RequestInit | undefined) => Response | Promise<Response>);

/**
 * Falsk fetch som svarer fra en tabell med URL-er. Ukjente URL-er gir 404, så
 * testene aldri går mot nettet. Alle kall logges i `calls`.
 */
export function createFakeFetch(routes: Record<string, Handler>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: input, headers });
    const handler = routes[input];
    if (!handler) return new Response("Not found", { status: 404 });
    // En Response kan bare leses én gang, så faste svar klones.
    return typeof handler === "function" ? handler(init) : handler.clone();
  };
  return { fetchImpl, calls, urls: () => calls.map((call) => call.url) };
}

export const xml = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8", ...headers } });

export const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

export const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });
