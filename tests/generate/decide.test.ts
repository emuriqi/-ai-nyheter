import { describe, expect, it } from "vitest";
import { parseSiteConfig } from "@/lib/config/schema";
import type { ModerateOutcome } from "@/lib/generate/claude";
import { decide } from "@/lib/generate/decide";
import type { Finding } from "@/lib/generate/findings";
import type { WrittenArticle } from "@/lib/generate/schema";
import { checkArticle } from "@/lib/generate/checks";
import { validConfig } from "../helpers/fixtures";
import { loadGeneratedArticles } from "../helpers/generated-articles";

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

  it("tar med modereringens funn, og stopper bare privatpersoner moderatoren er sikker på", () => {
    const moderation: ModerateOutcome = {
      ok: true,
      result: {
        vurdering: "flagget",
        funn: [
          { type: "udokumentert_påstand", alvor: "middels", utdrag: "u", forklaring: "Står ikke i kildene." },
          { type: "privatperson", alvor: "høy", utdrag: "Ola", forklaring: "Navngitt." },
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

  it("lar redaktøren vurdere usikre privatperson-funn fra moderatoren", () => {
    const moderation: ModerateOutcome = {
      ok: true,
      result: {
        vurdering: "ok",
        funn: [
          { type: "privatperson", alvor: "lav", utdrag: "pressetalsperson Kari Nilsen", forklaring: "Trolig i orden." },
        ],
        sensitive_temaer: [],
      },
    };
    for (const editorial of [base, flaggedOnly]) {
      const decision = decide(article(), [], moderation, editorial);
      expect(decision).toMatchObject({ verdict: "FLAGGED", blocked: false, autoPublish: false });
      expect(decision.findings[0]).toMatchObject({ kind: "privatperson", severity: "høy" });
    }
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
    expect(decision).toMatchObject({
      verdict: "FLAGGED",
      autoPublish: false,
      sensitiveThemes: ["ulykker", "helse"],
      sensitive: true,
    });
    expect(decision.findings.filter((f) => f.kind === "sensitivt_tema")).toHaveLength(2);
  });

  it("flagger et sensitivt tema som moderatoren bare melder som funn med lav alvor", () => {
    const moderation: ModerateOutcome = {
      ok: true,
      result: {
        vurdering: "ok",
        funn: [{ type: "sensitivt_tema", alvor: "lav", utdrag: "døde", forklaring: "Saken omtaler et dødsfall." }],
        sensitive_temaer: [],
      },
    };
    const decision = decide(article(), [], moderation, flaggedOnly);
    expect(decision).toMatchObject({ verdict: "FLAGGED", autoPublish: false, sensitiveThemes: [], sensitive: true });
    expect(decision.findings[0]).toMatchObject({ kind: "sensitivt_tema", severity: "høy" });
  });

  it("flagger når modereringen ikke kunne kjøre", () => {
    const decision = decide(
      article(),
      [],
      { ok: false, reason: "Moderering uten svar: svaret kunne ikke tolkes", stopRun: false },
      flaggedOnly,
    );
    expect(decision).toMatchObject({ verdict: "FLAGGED", blocked: false, autoPublish: false });
    expect(decision.findings[0]).toMatchObject({ kind: "moderering_mangler", severity: "høy" });
  });

  it("flagger skriverens merknader om hull eller motstrid i kildene", () => {
    const decision = decide(article({ usikkerhet: ["K1 sier tre døde, K2 sier fire."] }), [], clean, flaggedOnly);
    expect(decision).toMatchObject({ verdict: "FLAGGED", autoPublish: false });
    expect(decision.findings).toEqual([
      { origin: "skriver", kind: "usikkerhet", severity: "middels", message: "K1 sier tre døde, K2 sier fire." },
    ]);
  });

  it("flagger når eneste funn har alvor middels", () => {
    const checks: Finding[] = [{ origin: "kontroll", kind: "tall_uten_kilde", severity: "middels", message: "m" }];
    expect(decide(article(), checks, clean, flaggedOnly)).toMatchObject({
      verdict: "FLAGGED",
      blocked: false,
      autoPublish: false,
    });
    // Funn med alvor lav eller info flagger ikke.
    const minor: Finding[] = [{ origin: "kontroll", kind: "kildehenvisning_i_teksten", severity: "lav", message: "m" }];
    expect(decide(article(), minor, clean, flaggedOnly)).toMatchObject({ verdict: "OK", autoPublish: true });
  });

  it("flagger et sensitivt tema som bare moderatoren oppgir", () => {
    const moderation: ModerateOutcome = {
      ok: true,
      result: { vurdering: "ok", funn: [], sensitive_temaer: ["kriminalitet"] },
    };
    const decision = decide(article({ sensitive_temaer: [] }), [], moderation, flaggedOnly);
    expect(decision).toMatchObject({
      verdict: "FLAGGED",
      autoPublish: false,
      sensitiveThemes: ["kriminalitet"],
      sensitive: true,
    });
  });
});

describe("samlet vurdering av de syntetiske artiklene", () => {
  const saker = loadGeneratedArticles();
  const variants = saker.flatMap((s) => s.variants.map((v) => [s.event, v.feil, s, v] as const));
  /** De innplantede feilene som bryter en fast regel og ikke kan publiseres. */
  const BLOCKING = new Set(["langt_sitat", "oppdiktet_sitat", "kopiert_tekst", "privatperson"]);

  it.each(variants)("%s: %s publiseres aldri automatisk", (_event, feil, sak, variant) => {
    const decision = decide(variant.artikkel, checkArticle(variant.artikkel, sak.sources, base), clean, flaggedOnly);
    expect(decision).toMatchObject({ verdict: "FLAGGED", autoPublish: false, blocked: BLOCKING.has(feil) });
  });

  it.each(saker.map((s) => [s.event, s]))("den gode artikkelen om %s blokkeres ikke", (_event, sak) => {
    const good = { ...sak.good, usikkerhet: [] };
    expect(decide(good, checkArticle(good, sak.sources, base), clean, flaggedOnly)).toMatchObject({
      verdict: "OK",
      blocked: false,
      autoPublish: true,
    });
  });
});
