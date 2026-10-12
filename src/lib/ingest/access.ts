import robotsParser from "robots-parser";
import { FetchError, politeFetch, type HttpOptions } from "./http";

/**
 * Sjekker om en URL kan hentes: robots.txt (RFC 9309) og reservasjoner mot
 * tekst- og datautvinning (TDMRep, W3C Community Group, og KI-crawlere som er
 * sperret i robots.txt).
 *
 * Ved tvil hentes ingenting: en robots.txt som ikke kan leses (5xx eller
 * nettverksfeil) behandles som full sperre, og en tdmrep.json som ikke kan
 * leses behandles som reservasjon.
 */

export type AccessDecision =
  | { ok: true }
  | { ok: false; kind: "robots" | "tdm"; reason: string };

type Robots = ReturnType<typeof robotsParser>;
type RobotsState = { kind: "parsed"; robots: Robots } | { kind: "allow-all" } | { kind: "disallow-all"; reason: string };
type TdmRule = { pattern: string; reserved: boolean };
type TdmState = { kind: "rules"; rules: TdmRule[] } | { kind: "unknown"; reason: string };

export type HostPolicy = {
  origin: string;
  robots: RobotsState;
  tdm: TdmState;
};

/** Produktnavnet i User-Agent («AI-nyheter/0.2 (...)» → «AI-nyheter»), brukt mot robots.txt. */
export function robotsToken(userAgent: string): string {
  return userAgent.split("/")[0];
}

/** Henter robots.txt og /.well-known/tdmrep.json for en vert. */
export async function loadHostPolicy(origin: string, http: HttpOptions): Promise<HostPolicy> {
  const [robots, tdm] = await Promise.all([loadRobots(origin, http), loadTdm(origin, http)]);
  return { origin, robots, tdm };
}

async function loadRobots(origin: string, http: HttpOptions): Promise<RobotsState> {
  const url = `${origin}/robots.txt`;
  try {
    const result = await politeFetch(url, { ...http, headers: { Accept: "text/plain" } });
    if (result.status >= 200 && result.status < 300) {
      return { kind: "parsed", robots: robotsParser(url, result.body) };
    }
    if (result.status >= 400 && result.status < 500) {
      // RFC 9309: «unavailable» betyr at det ikke finnes regler.
      return { kind: "allow-all" };
    }
    return { kind: "disallow-all", reason: `robots.txt svarte ${result.status}` };
  } catch (error) {
    return { kind: "disallow-all", reason: `robots.txt kunne ikke leses: ${errorMessage(error)}` };
  }
}

async function loadTdm(origin: string, http: HttpOptions): Promise<TdmState> {
  try {
    const result = await politeFetch(`${origin}/.well-known/tdmrep.json`, {
      ...http,
      headers: { Accept: "application/json" },
    });
    if (result.status >= 400 && result.status < 500) {
      return { kind: "rules", rules: [] };
    }
    if (result.status < 200 || result.status >= 300) {
      return { kind: "unknown", reason: `tdmrep.json svarte ${result.status}` };
    }
    return { kind: "rules", rules: parseTdmRep(result.body) };
  } catch (error) {
    return { kind: "unknown", reason: `tdmrep.json kunne ikke leses: ${errorMessage(error)}` };
  }
}

/** Leser tdmrep.json. Ugyldige regler ignoreres, slik protokollen krever. */
export function parseTdmRep(body: string): TdmRule[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.flatMap((rule): TdmRule[] => {
    if (typeof rule !== "object" || rule === null) return [];
    const { location, "tdm-reservation": reservation } = rule as Record<string, unknown>;
    if (typeof location !== "string" || (reservation !== 0 && reservation !== 1)) return [];
    return [{ pattern: location, reserved: reservation === 1 }];
  });
}

/** Mønster i robots.txt-stil: prefiks, «*» for hva som helst og «$» for slutt. */
export function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

/** Er stien reservert etter TDMRep-reglene? Det mest spesifikke (lengste) mønsteret vinner. */
export function isTdmReserved(rules: TdmRule[], path: string): boolean {
  let best: TdmRule | undefined;
  for (const rule of rules) {
    if (matchesPattern(rule.pattern, path) && (!best || rule.pattern.length > best.pattern.length)) {
      best = rule;
    }
  }
  return best?.reserved ?? false;
}

/** «tdm-reservation: 1» i HTTP-headeren eller i en <meta>-tag. */
export function tdmReservedByHeaderOrMeta(headers: Headers, html?: string): boolean {
  if (headers.get("tdm-reservation")?.trim() === "1") return true;
  if (!html) return false;
  const meta = /<meta\s[^>]*name=["']tdm-reservation["'][^>]*>/i.exec(html)?.[0];
  return meta ? /content=["']\s*1\s*["']/i.test(meta) : false;
}

/** Avgjør om URL-en kan hentes, gitt reglene for verten. */
export function checkAccess(
  policy: HostPolicy,
  url: string,
  { userAgent, aiCrawlerTokens }: { userAgent: string; aiCrawlerTokens: string[] },
): AccessDecision {
  const target = new URL(url);
  if (target.origin !== policy.origin) {
    return { ok: false, kind: "robots", reason: `URL-en hører ikke til ${policy.origin}` };
  }

  const robots = policy.robots;
  if (robots.kind === "disallow-all") {
    return { ok: false, kind: "robots", reason: robots.reason };
  }
  if (robots.kind === "parsed") {
    if (robots.robots.isAllowed(url, robotsToken(userAgent)) === false) {
      return { ok: false, kind: "robots", reason: `robots.txt sperrer ${target.pathname}` };
    }
    const blockedAi = aiCrawlerTokens.find((token) => robots.robots.isAllowed(url, token) === false);
    if (blockedAi) {
      return {
        ok: false,
        kind: "tdm",
        reason: `robots.txt sperrer KI-crawleren ${blockedAi}, tolket som reservasjon mot tekst- og datautvinning`,
      };
    }
  }

  if (policy.tdm.kind === "unknown") {
    return { ok: false, kind: "tdm", reason: policy.tdm.reason };
  }
  if (isTdmReserved(policy.tdm.rules, target.pathname + target.search)) {
    return { ok: false, kind: "tdm", reason: "tdmrep.json reserverer stien mot tekst- og datautvinning" };
  }
  return { ok: true };
}

function errorMessage(error: unknown): string {
  return error instanceof FetchError || error instanceof Error ? error.message : String(error);
}
