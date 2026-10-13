import { describe, expect, it } from "vitest";
import rawConfig from "@config/site.config";
import { parseSiteConfig } from "@/lib/config/schema";
import { activeSource, validConfig } from "./helpers/fixtures";

function errorFor(config: unknown): string {
  try {
    parseSiteConfig(config);
  } catch (error) {
    return String(error);
  }
  throw new Error("forventet at konfigurasjonen skulle avvises");
}

describe("config/site.config.ts", () => {
  // Skjemaets regler for aktive kilder testes nedenfor, så dette fanger alle brudd.
  it("er gyldig", () => {
    expect(() => parseSiteConfig(rawConfig)).not.toThrow();
  });
});

describe("parseSiteConfig", () => {
  it("godtar en gyldig konfigurasjon", () => {
    expect(parseSiteConfig(validConfig()).sources).toHaveLength(1);
  });

  describe("en aktiv kilde", () => {
    it("må ha åpen lisens", () => {
      expect(errorFor(validConfig({ sources: [activeSource({ license: "UNKNOWN" })] }))).toContain("åpen lisens");
    });

    it("må ha leste vilkår", () => {
      expect(errorFor(validConfig({ sources: [activeSource({ termsReviewedAt: null })] }))).toContain(
        "vilkårene må være lest",
      );
    });

    it("kan ikke ha TDM-reservasjon eller ukjent status", () => {
      for (const tdmReservation of ["RESERVED", "UNKNOWN"] as const) {
        expect(errorFor(validConfig({ sources: [activeSource({ tdmReservation })] }))).toContain("TDM");
      }
    });

    it("må ha feedUrl", () => {
      expect(errorFor(validConfig({ sources: [activeSource({ feedUrl: null })] }))).toContain("feedUrl");
    });
  });

  it("godtar en kilde som må verifiseres selv om lisensen er ukjent", () => {
    const source = activeSource({
      status: "NEEDS_VERIFICATION",
      license: "UNKNOWN",
      termsReviewedAt: null,
      tdmReservation: "UNKNOWN",
      feedUrl: null,
    });
    expect(() => parseSiteConfig(validConfig({ sources: [source] }))).not.toThrow();
  });

  it("tillater bare henting av fulltekst fra kilder med åpen lisens", () => {
    const source = activeSource({ status: "PAUSED", license: "UNKNOWN", allowFullTextFetch: true });
    expect(errorFor(validConfig({ sources: [source] }))).toContain("fulltekst");
  });

  it("krever https for kildeadresser", () => {
    expect(errorFor(validConfig({ sources: [activeSource({ feedUrl: "http://example.no/rss" })] }))).toContain(
      "feedUrl",
    );
  });

  it("avviser kilder med samme slug", () => {
    const sources = [activeSource(), activeSource({ name: "Kopi" })];
    expect(errorFor(validConfig({ sources }))).toContain("flere ganger");
  });

  it("avviser sletteperiode under én dag", () => {
    const retention = { sourceTextDays: 0, chatLogDays: 0, jobRunDays: 90 };
    expect(errorFor(validConfig({ retention }))).toContain("sourceTextDays");
  });

  it("krever at grensene for grupperingen henger sammen", () => {
    const clustering = validConfig().clustering!;
    expect(
      errorFor(validConfig({ clustering: { ...clustering, borderlineThreshold: 0.5, sameStoryThreshold: 0.4 } })),
    ).toContain("borderlineThreshold kan ikke være høyere enn sameStoryThreshold");
    expect(errorFor(validConfig({ clustering: { ...clustering, maxStoryHours: 24, storyWindowHours: 72 } }))).toContain(
      "maxStoryHours kan ikke være kortere enn storyWindowHours",
    );
  });

  const base = validConfig();

  it.each([
    ["privacy.storeIpAddresses", { privacy: { ...base.privacy, storeIpAddresses: true } }],
    ["privacy.analytics", { privacy: { ...base.privacy, analytics: "GOOGLE_ANALYTICS" } }],
    ["editorial.neverNamePrivatePersons", { editorial: { ...base.editorial, neverNamePrivatePersons: false } }],
    ["editorial.showSourceImages", { editorial: { ...base.editorial, showSourceImages: true } }],
    ["editorial.manualApproval", { editorial: { ...base.editorial, manualApproval: "NONE" } }],
    ["editorial.sensitiveCategories", { editorial: { ...base.editorial, sensitiveCategories: [] } }],
    ["editorial.minSourcesForPersonClaims", { editorial: { ...base.editorial, minSourcesForPersonClaims: 0 } }],
    ["ai.articleLabel", { ai: { ...base.ai, articleLabel: "" } }],
    ["ai.chatLabel", { ai: { ...base.ai, chatLabel: "" } }],
    ["retention.chatLogDays", { retention: { ...base.retention, chatLogDays: 31 } }],
    ["sources[0].termsUrl", { sources: [activeSource({ termsUrl: "http://example.no/vilkar" })] }],
    ["ingestion.userAgent", { ingestion: { ...base.ingestion, userAgent: "AI-nyheter/1.0 (uten kontakt)" } }],
    ["ingestion.userAgent", { ingestion: { ...base.ingestion, userAgent: "https://example.no" } }],
    ["ingestion.maxItemAgeDays", { ingestion: { ...base.ingestion, maxItemAgeDays: 365 } }],
    ["sources[0].adapter", { sources: [activeSource({ adapter: "skraping" as "rss" })] }],
  ])("avviser ulovlig verdi for %s", (path, overrides) => {
    expect(errorFor({ ...base, ...overrides })).toContain(path);
  });
});
