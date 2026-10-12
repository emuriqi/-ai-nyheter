import { parseHTML } from "linkedom";
import robotsParser from "robots-parser";
import { FetchError, politeFetch, type HttpOptions } from "./http";

/**
 * Sjekker om en URL kan hentes: robots.txt (RFC 9309) og reservasjoner mot
 * tekst- og datautvinning (TDMRep, W3C Community Group, og KI-crawlere som er
 * sperret i robots.txt).
 *
 * Ved tvil hentes ingenting: en robots.txt som ikke kan leses (5xx, 429 eller
 * nettverksfeil) behandles som full sperre, og en tdmrep.json som ikke kan
 * leses behandles som ukjent, som også stopper hentingen.
 */

export type AccessDecision =
  | { ok: true }
  | { ok: false; kind: "robots" | "tdm"; reason: string; unknown?: boolean };

type Robots = ReturnType<typeof robotsParser>;
type RobotsState = { kind: "parsed"; robots: Robots } | { kind: "allow-all" } | { kind: "disallow-all"; reason: string };
type TdmRule = { pattern: string; reserved: boolean };
type TdmState = { kind: "rules"; rules: TdmRule[] } | { kind: "unknown"; reason: string };

export type HostPolicy = {
  origin: string;
  robots: RobotsState;
  tdm: TdmState;
};

type AccessOptions = { userAgent: string; aiCrawlerTokens: string[] };

/** Grenser for tdmrep.json, så en stor eller fiendtlig fil ikke kan gjøre sjekken treg. */
const MAX_TDM_RULES = 500;
const MAX_PATTERN_LENGTH = 1000;
/** Bare starten av en HTML-side leses når vi leter etter tdm-reservation i <meta>. */
const META_SCAN_BYTES = 64 * 1024;

/** Produktnavnet i User-Agent («AI-nyheter/0.2 (...)» → «AI-nyheter»), brukt mot robots.txt. */
export function robotsToken(userAgent: string): string {
  return userAgent.split("/")[0];
}

/**
 * Henter robots.txt og deretter /.well-known/tdmrep.json for en vert.
 * tdmrep.json hentes bare når robots.txt tillater det.
 */
export async function loadHostPolicy(
  origin: string,
  http: HttpOptions,
  options: { userAgent: string },
): Promise<HostPolicy> {
  const robots = await loadRobots(origin, http);
  const tdmUrl = `${origin}/.well-known/tdmrep.json`;
  const tdm: TdmState = robotsAllows(robots, tdmUrl, robotsToken(options.userAgent))
    ? await loadTdm(tdmUrl, http)
    : { kind: "unknown", reason: "robots.txt tillater ikke å lese tdmrep.json" };
  return { origin, robots, tdm };
}

async function loadRobots(origin: string, http: HttpOptions): Promise<RobotsState> {
  const url = `${origin}/robots.txt`;
  try {
    const result = await politeFetch(url, { ...http, headers: { Accept: "text/plain" } });
    if (result.status >= 200 && result.status < 300) {
      return { kind: "parsed", robots: robotsParser(url, result.body) };
    }
    if (result.status === 429) {
      // Serveren ber oss vente. Da vet vi ikke hva reglene er, så vi henter ingenting.
      return { kind: "disallow-all", reason: "robots.txt svarte 429 (for mange forespørsler)" };
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

async function loadTdm(url: string, http: HttpOptions): Promise<TdmState> {
  try {
    const result = await politeFetch(url, { ...http, headers: { Accept: "application/json" } });
    if (result.status === 429) {
      return { kind: "unknown", reason: "tdmrep.json svarte 429 (for mange forespørsler)" };
    }
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
  return data.slice(0, MAX_TDM_RULES).flatMap((rule): TdmRule[] => {
    if (typeof rule !== "object" || rule === null) return [];
    const { location, "tdm-reservation": reservation } = rule as Record<string, unknown>;
    if (typeof location !== "string" || location.length > MAX_PATTERN_LENGTH) return [];
    if (reservation !== 0 && reservation !== 1) return [];
    return [{ pattern: location, reserved: reservation === 1 }];
  });
}

/**
 * Mønster i robots.txt-stil: prefiks, «*» for hva som helst og «$» for slutt.
 * Matcher i lineær tid (ingen regulære uttrykk), så mønstre fra en ekstern
 * tdmrep.json ikke kan låse prosessen.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0];
  if (!path.startsWith(first)) return false;
  let position = first.length;

  if (parts.length === 1) {
    return anchored ? path.length === first.length : true;
  }
  const last = parts[parts.length - 1];
  for (const part of parts.slice(1, -1)) {
    const index = path.indexOf(part, position);
    if (index < 0) return false;
    position = index + part.length;
  }
  if (anchored) {
    return path.length - last.length >= position && path.endsWith(last);
  }
  return path.indexOf(last, position) >= 0;
}

/**
 * Er stien reservert etter TDMRep-reglene? Protokollen sier at det mest
 * spesifikke treffet gjelder, og at det er det første i rekkefølgen.
 */
export function isTdmReserved(rules: TdmRule[], path: string): boolean {
  return rules.find((rule) => matchesPattern(rule.pattern, path))?.reserved ?? false;
}

/** «tdm-reservation: 1» i HTTP-headeren eller i en <meta>-tag i starten av siden. */
export function tdmReservedByHeaderOrMeta(headers: Headers, html?: string): boolean {
  if (headers.get("tdm-reservation")?.trim() === "1") return true;
  if (!html || !/tdm-reservation/i.test(html.slice(0, META_SCAN_BYTES))) return false;
  const { document } = parseHTML(html.slice(0, META_SCAN_BYTES));
  // Attributtnavn sammenlignes uten hensyn til store og små bokstaver (linkedom gjør det ikke selv).
  for (const meta of document.querySelectorAll("meta")) {
    const attributes = new Map(
      Array.from(meta.attributes as ArrayLike<{ name: string; value: string }>, (attr) => [
        attr.name.toLowerCase(),
        attr.value.trim(),
      ]),
    );
    if (attributes.get("name")?.toLowerCase() === "tdm-reservation") {
      return attributes.get("content") === "1";
    }
  }
  return false;
}

/** Resultatet av robots- og TDM-sjekken hver for seg, til visning i admin. */
export type AccessReport = {
  robots: AccessDecision;
  /** null når TDM ikke ble vurdert fordi robots.txt allerede sperret. */
  tdm: AccessDecision | null;
};

export function evaluateAccess(policy: HostPolicy, url: string, options: AccessOptions): AccessReport {
  const target = new URL(url);
  if (target.origin !== policy.origin) {
    return { robots: { ok: false, kind: "robots", reason: `URL-en hører ikke til ${policy.origin}` }, tdm: null };
  }
  const robots = checkRobots(policy.robots, url, options);
  if (!robots.ok) {
    return { robots, tdm: null };
  }
  return { robots, tdm: checkTdm(policy, target, options) };
}

/** Avgjør om URL-en kan hentes, gitt reglene for verten. */
export function checkAccess(policy: HostPolicy, url: string, options: AccessOptions): AccessDecision {
  const { robots, tdm } = evaluateAccess(policy, url, options);
  return robots.ok ? (tdm ?? robots) : robots;
}

function checkRobots(state: RobotsState, url: string, options: AccessOptions): AccessDecision {
  if (state.kind === "disallow-all") {
    return { ok: false, kind: "robots", reason: state.reason };
  }
  if (!robotsAllows(state, url, robotsToken(options.userAgent))) {
    return { ok: false, kind: "robots", reason: `robots.txt sperrer ${new URL(url).pathname}` };
  }
  return { ok: true };
}

function checkTdm(policy: HostPolicy, target: URL, options: AccessOptions): AccessDecision {
  if (policy.robots.kind === "parsed") {
    const robots = policy.robots.robots;
    const blockedAi = options.aiCrawlerTokens.find((token) => robots.isAllowed(target.toString(), token) === false);
    if (blockedAi) {
      return {
        ok: false,
        kind: "tdm",
        reason: `robots.txt sperrer KI-crawleren ${blockedAi}, tolket som reservasjon mot tekst- og datautvinning`,
      };
    }
  }
  if (policy.tdm.kind === "unknown") {
    return { ok: false, kind: "tdm", reason: policy.tdm.reason, unknown: true };
  }
  if (isTdmReserved(policy.tdm.rules, target.pathname + target.search)) {
    return { ok: false, kind: "tdm", reason: "tdmrep.json reserverer stien mot tekst- og datautvinning" };
  }
  return { ok: true };
}

function robotsAllows(state: RobotsState, url: string, token: string): boolean {
  if (state.kind === "allow-all") return true;
  if (state.kind === "disallow-all") return false;
  return state.robots.isAllowed(url, token) !== false;
}

function errorMessage(error: unknown): string {
  return error instanceof FetchError || error instanceof Error ? error.message : String(error);
}
