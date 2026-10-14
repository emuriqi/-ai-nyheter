import { describe, expect, it } from "vitest";
import { parseSiteConfig } from "@/lib/config/schema";
import type { ModerateOutcome } from "@/lib/generate/claude";
import { decide } from "@/lib/generate/decide";
import type { Finding } from "@/lib/generate/findings";
import type { WrittenArticle } from "@/lib/generate/schema";
import { validConfig } from "../helpers/fixtures";

const base = parseSiteConfig(validConfig()).editorial;
const flaggedOnly = { ...base, manualApproval: "FLAGGED_ONLY" as const };

const article = (overrides: Partial<WrittenArticle> = {}): WrittenArticle => ({
  tittel: "T",
  ingress: "I",
  brodtekst: "B",
  kategori: "samfunn",
  sensitive_temaer: [],
  personer: [],
  kilder_brukt: ["K1"],
  usikkerhet: [],
  ...overrides,
});

const clean: ModerateOutcome = { ok: true, result: { vurdering: "ok", funn: [], sensitive_temaer: [] } };

describe("samlet vurdering", () => {
  it("publiserer automatisk bare med FLAGGED_ONLY og ingen funn", () => {
    expect(decide(article(), [], clean, flaggedOnly)).toMatchObject({
      verdict: "OK",
      blocked: false,
      autoPublish: true,
    });
    // Med ALL går alt til godkjenning.
    expect(decide(article(), [], clean, base)).toMatchObject({ verdict: "OK", autoPublish: false });
  });

  it("flagger og stopper ved brudd på en fast regel", () => {
    const checks: Finding[] = [{ origin: "kontroll", kind: "kopiert_tekst", severity: "blokkerer", message: "m" }];
    expect(decide(article(), checks, clean, flaggedOnly)).toMatchObject({
      verdict: "FLAGGED",
      blocked: true,
      autoPublish: false,
    });
  });

  it("tar med modereringens funn, og gjør privatpersoner til brudd på en fast regel", () => {
    const moderation: ModerateOutcome = {
      ok: true,
      result: {
        vurdering: "flagget",
        funn: [
          { type: "udokumentert_påstand", alvor: "middels", utdrag: "u", forklaring: "Står ikke i kildene." },
          { type: "privatperson", alvor: "lav", utdrag: "Ola", forklaring: "Navngitt." },
          { type: "annet", alvor: "lav", utdrag: "", forklaring: "Småtteri." },
        ],
        sensitive_temaer: [],
      },
    };
    const decision = decide(article(), [], moderation, flaggedOnly);
    expect(decision).toMatchObject({ verdict: "FLAGGED", blocked: true, autoPublish: false });
    expect(decision.findings.map((f) => [f.origin, f.kind, f.severity, f.excerpt])).toEqual([
      ["moderering", "privatperson", "blokkerer", "Ola"],
      ["moderering", "udokumentert_påstand", "middels", "u"],
      ["moderering", "annet", "lav", undefined],
    ]);
  });

  it("flagger når moderatoren selv sier flagget, også uten funn over lav", () => {
    const moderation: ModerateOutcome = { ok: true, result: { vurdering: "flagget", funn: [], sensitive_temaer: [] } };
    expect(decide(article(), [], moderation, flaggedOnly)).toMatchObject({ verdict: "FLAGGED", autoPublish: false });
  });

  it("flagger sensitive temaer fra skriveren og moderatoren", () => {
    const moderation: ModerateOutcome = {
      ok: true,
      result: { vurdering: "ok", funn: [], sensitive_temaer: ["helse"] },
    };
    const decision = decide(article({ sensitive_temaer: ["ulykker", "helse"] }), [], moderation, flaggedOnly);
    expect(decision).toMatchObject({ verdict: "FLAGGED", autoPublish: false, sensitiveThemes: ["ulykker", "helse"] });
    expect(decision.findings.filter((f) => f.kind === "sensitivt_tema")).toHaveLength(2);
  });

  it("flagger når modereringen ikke kunne kjøre", () => {
    const decision = decide(article(), [], { ok: false, reason: "Moderering feilet: APIError (500)" }, flaggedOnly);
    expect(decision).toMatchObject({ verdict: "FLAGGED", blocked: false, autoPublish: false });
    expect(decision.findings[0]).toMatchObject({ kind: "moderering_mangler", severity: "høy" });
  });

  it("tar med skriverens merknader om usikkerhet til orientering uten å flagge", () => {
    const decision = decide(article({ usikkerhet: ["Kildene sier ikke hvilken kommune."] }), [], clean, flaggedOnly);
    expect(decision).toMatchObject({ verdict: "OK", autoPublish: true });
    expect(decision.findings).toEqual([
      { origin: "skriver", kind: "usikkerhet", severity: "info", message: "Kildene sier ikke hvilken kommune." },
    ]);
  });
});
