import { describe, expect, it } from "vitest";
import {
  checkAccess,
  isTdmReserved,
  loadHostPolicy,
  matchesPattern,
  parseTdmRep,
  robotsToken,
  tdmReservedByHeaderOrMeta,
} from "@/lib/ingest/access";
import { createFakeFetch, text } from "../helpers/fake-fetch";

const USER_AGENT = "AI-nyheter/0.2 (+https://example.no/kontakt)";
const AI = { userAgent: USER_AGENT, aiCrawlerTokens: ["ClaudeBot", "GPTBot"] };
const http = (fetchImpl: ReturnType<typeof createFakeFetch>["fetchImpl"]) => ({
  userAgent: USER_AGENT,
  timeoutMs: 1000,
  maxBytes: 10_000,
  fetchImpl,
});

async function policy(robots: Response | null, tdmrep: Response | null = null) {
  const routes: Record<string, Response> = {};
  if (robots) routes["https://example.no/robots.txt"] = robots;
  if (tdmrep) routes["https://example.no/.well-known/tdmrep.json"] = tdmrep;
  return loadHostPolicy("https://example.no", http(createFakeFetch(routes).fetchImpl));
}

describe("robots.txt", () => {
  it("bruker produktnavnet fra User-Agent", () => {
    expect(robotsToken(USER_AGENT)).toBe("AI-nyheter");
  });

  it("følger Disallow og Allow for vår crawler", async () => {
    const p = await policy(text("User-agent: *\nDisallow: /privat/\nAllow: /privat/offentlig\n"));
    expect(checkAccess(p, "https://example.no/rss", AI)).toEqual({ ok: true });
    expect(checkAccess(p, "https://example.no/privat/x", AI)).toMatchObject({ ok: false, kind: "robots" });
    expect(checkAccess(p, "https://example.no/privat/offentlig", AI)).toEqual({ ok: true });
  });

  it("tolker sperre for KI-crawlere som reservasjon mot tekst- og datautvinning", async () => {
    const p = await policy(text("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"));
    expect(checkAccess(p, "https://example.no/rss", AI)).toMatchObject({ ok: false, kind: "tdm" });
  });

  it("tillater alt når robots.txt ikke finnes (4xx), og sperrer alt ved serverfeil (RFC 9309)", async () => {
    expect(checkAccess(await policy(null), "https://example.no/rss", AI)).toEqual({ ok: true });
    expect(checkAccess(await policy(text("feil", 503)), "https://example.no/rss", AI)).toMatchObject({
      ok: false,
      kind: "robots",
      reason: "robots.txt svarte 503",
    });
  });

  it("avviser URL-er på andre verter", async () => {
    const p = await policy(null);
    expect(checkAccess(p, "https://annen.no/rss", AI)).toMatchObject({ ok: false });
  });
});

describe("TDMRep", () => {
  it("matcher mønstre som i robots.txt", () => {
    expect(matchesPattern("/", "/hva/som/helst")).toBe(true);
    expect(matchesPattern("/blogg/", "/blogg/innlegg")).toBe(true);
    expect(matchesPattern("/blogg/", "/nyheter")).toBe(false);
    expect(matchesPattern("/*.pdf$", "/rapport.pdf")).toBe(true);
    expect(matchesPattern("/*.pdf$", "/rapport.pdf?x=1")).toBe(false);
    expect(matchesPattern("/a.b", "/axb")).toBe(false);
  });

  it("bruker det mest spesifikke mønsteret", () => {
    const rules = parseTdmRep(
      JSON.stringify([
        { location: "/", "tdm-reservation": 1 },
        { location: "/pressemeldinger/", "tdm-reservation": 0 },
      ]),
    );
    expect(isTdmReserved(rules, "/nyheter/1")).toBe(true);
    expect(isTdmReserved(rules, "/pressemeldinger/1")).toBe(false);
  });

  it("ignorerer ugyldige regler og ugyldig JSON", () => {
    expect(parseTdmRep('[{"location": "/", "tdm-reservation": "ja"}, {"tdm-reservation": 1}]')).toEqual([]);
    expect(parseTdmRep("ikke json")).toEqual([]);
  });

  it("sperrer når tdmrep.json reserverer stien", async () => {
    const p = await policy(null, text(JSON.stringify([{ location: "/", "tdm-reservation": 1 }])));
    expect(checkAccess(p, "https://example.no/rss", AI)).toMatchObject({ ok: false, kind: "tdm" });
  });

  it("sperrer når tdmrep.json ikke kan leses, men ikke når den mangler", async () => {
    expect(checkAccess(await policy(null, text("feil", 500)), "https://example.no/rss", AI)).toMatchObject({
      ok: false,
      kind: "tdm",
    });
    expect(checkAccess(await policy(null, text("finnes ikke", 404)), "https://example.no/rss", AI)).toEqual({
      ok: true,
    });
  });

  it("leser reservasjon fra HTTP-header og meta-tag", () => {
    expect(tdmReservedByHeaderOrMeta(new Headers({ "tdm-reservation": "1" }))).toBe(true);
    expect(tdmReservedByHeaderOrMeta(new Headers({ "tdm-reservation": "0" }))).toBe(false);
    expect(tdmReservedByHeaderOrMeta(new Headers(), '<meta name="tdm-reservation" content="1">')).toBe(true);
    expect(tdmReservedByHeaderOrMeta(new Headers(), '<meta content="1" name="tdm-reservation">')).toBe(true);
    expect(tdmReservedByHeaderOrMeta(new Headers(), '<meta name="tdm-reservation" content="0">')).toBe(false);
  });
});
