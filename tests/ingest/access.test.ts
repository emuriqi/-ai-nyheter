import { describe, expect, it } from "vitest";
import {
  checkAccess,
  evaluateAccess,
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

type Handler = Parameters<typeof createFakeFetch>[0][string];

async function policy(robots: Handler | null, tdmrep: Handler | null = null) {
  const routes: Record<string, Handler> = {};
  if (robots) routes["https://example.no/robots.txt"] = robots;
  if (tdmrep) routes["https://example.no/.well-known/tdmrep.json"] = tdmrep;
  const fake = createFakeFetch(routes);
  const p = await loadHostPolicy(
    "https://example.no",
    { userAgent: USER_AGENT, timeoutMs: 50, maxBytes: 10_000, fetchImpl: fake.fetchImpl },
    { userAgent: USER_AGENT },
  );
  return Object.assign(p, { urls: fake.urls() });
}

const networkError = () => Promise.reject(new TypeError("fetch failed"));

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

  it("tillater alt når robots.txt ikke finnes (4xx)", async () => {
    expect(checkAccess(await policy(null), "https://example.no/rss", AI)).toEqual({ ok: true });
    expect(checkAccess(await policy(text("forbudt", 403)), "https://example.no/rss", AI)).toEqual({ ok: true });
  });

  it.each([
    ["serverfeil", () => text("feil", 503)],
    ["429 for mange forespørsler", () => text("vent", 429)],
    ["nettverksfeil", networkError],
    ["tidsavbrudd", (init: RequestInit | undefined) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))],
    ["omdirigering til en annen vert", () => new Response(null, { status: 301, headers: { location: "https://cdn.annen.no/robots.txt" } })],
  ])("sperrer alt når robots.txt ikke kan leses (%s)", async (_name, handler) => {
    const p = await policy(handler);
    expect(checkAccess(p, "https://example.no/rss", AI)).toMatchObject({ ok: false, kind: "robots" });
  });

  it("henter ikke tdmrep.json når robots.txt sperrer alt", async () => {
    const p = await policy(text("User-agent: *\nDisallow: /\n"), text("[]"));
    expect(p.urls).toEqual(["https://example.no/robots.txt"]);
  });

  it("avviser URL-er på andre verter", async () => {
    const p = await policy(null);
    expect(checkAccess(p, "https://annen.no/rss", AI)).toMatchObject({ ok: false });
  });

  it("rapporterer robots og TDM hver for seg, og vurderer ikke TDM når robots sperrer", async () => {
    const reserved = text(JSON.stringify([{ location: "/", "tdm-reservation": 1 }]));
    const blocked = await policy(text("User-agent: *\nDisallow: /rss\n"), reserved);
    expect(evaluateAccess(blocked, "https://example.no/rss", AI)).toMatchObject({ robots: { ok: false }, tdm: null });

    const open = await policy(null, reserved);
    expect(evaluateAccess(open, "https://example.no/rss", AI)).toMatchObject({
      robots: { ok: true },
      tdm: { ok: false, kind: "tdm" },
    });
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
    expect(matchesPattern("/a*b*c", "/aXbYc")).toBe(true);
    expect(matchesPattern("/a*b*c", "/aXcYb")).toBe(false);
    expect(matchesPattern("*", "/")).toBe(true);
    expect(matchesPattern("/sak$", "/sak")).toBe(true);
    expect(matchesPattern("/sak$", "/saker")).toBe(false);
  });

  it("matcher i lineær tid, også med fiendtlige mønstre", () => {
    const hostile = `/${"*".repeat(5000)}X`;
    const start = performance.now();
    expect(matchesPattern(hostile, `/${"a".repeat(5000)}`)).toBe(false);
    expect(matchesPattern(hostile, "/eksport/saker?format=json")).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("bruker den første regelen som matcher, slik protokollen krever", () => {
    const rules = parseTdmRep(
      JSON.stringify([
        { location: "/pressemeldinger/", "tdm-reservation": 0 },
        { location: "/", "tdm-reservation": 1 },
      ]),
    );
    expect(isTdmReserved(rules, "/nyheter/1")).toBe(true);
    expect(isTdmReserved(rules, "/pressemeldinger/1")).toBe(false);

    const catchAllFirst = parseTdmRep(
      JSON.stringify([
        { location: "/", "tdm-reservation": 1 },
        { location: "/pressemeldinger/", "tdm-reservation": 0 },
      ]),
    );
    expect(isTdmReserved(catchAllFirst, "/pressemeldinger/1")).toBe(true);
  });

  it("ignorerer ugyldige regler, ugyldig JSON og for lange mønstre", () => {
    expect(parseTdmRep('[{"location": "/", "tdm-reservation": "ja"}, {"tdm-reservation": 1}]')).toEqual([]);
    expect(parseTdmRep("ikke json")).toEqual([]);
    expect(parseTdmRep(JSON.stringify([{ location: "/" + "a".repeat(2000), "tdm-reservation": 1 }]))).toEqual([]);
  });

  it("sperrer når tdmrep.json reserverer stien", async () => {
    const p = await policy(null, text(JSON.stringify([{ location: "/", "tdm-reservation": 1 }])));
    expect(checkAccess(p, "https://example.no/rss", AI)).toMatchObject({ ok: false, kind: "tdm" });
  });

  it.each([
    ["serverfeil", () => text("feil", 500)],
    ["429", () => text("vent", 429)],
    ["nettverksfeil", networkError],
  ])("sperrer som ukjent når tdmrep.json ikke kan leses (%s)", async (_name, handler) => {
    const p = await policy(null, handler);
    expect(checkAccess(p, "https://example.no/rss", AI)).toMatchObject({ ok: false, kind: "tdm", unknown: true });
  });

  it("sperrer ikke når tdmrep.json mangler", async () => {
    expect(checkAccess(await policy(null, text("finnes ikke", 404)), "https://example.no/rss", AI)).toEqual({
      ok: true,
    });
  });

  it("leser reservasjon fra HTTP-header og meta-tag, også uten anførselstegn", () => {
    expect(tdmReservedByHeaderOrMeta(new Headers({ "tdm-reservation": "1" }))).toBe(true);
    expect(tdmReservedByHeaderOrMeta(new Headers({ "tdm-reservation": "0" }))).toBe(false);
    const meta = (tag: string) => tdmReservedByHeaderOrMeta(new Headers(), `<html><head>${tag}</head></html>`);
    expect(meta('<meta name="tdm-reservation" content="1">')).toBe(true);
    expect(meta('<meta content="1" name="tdm-reservation">')).toBe(true);
    expect(meta("<meta name=tdm-reservation content=1>")).toBe(true);
    expect(meta('<META NAME="TDM-Reservation" CONTENT=" 1 ">')).toBe(true);
    expect(meta('<meta name="tdm-reservation" content="0">')).toBe(false);
  });

  it("leter etter meta-taggen raskt, også i fiendtlig HTML", () => {
    const start = performance.now();
    expect(tdmReservedByHeaderOrMeta(new Headers(), "<meta ".repeat(200_000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
