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
  it("er gyldig", () => {
    expect(() => parseSiteConfig(rawConfig)).not.toThrow();
  });

  it("har ingen aktive kilder uten leste vilkår og åpen lisens", () => {
    const config = parseSiteConfig(rawConfig);
    for (const source of config.sources.filter((s) => s.status === "ACTIVE")) {
      expect(source.termsReviewedAt).not.toBeNull();
      expect(source.license).not.toBe("UNKNOWN");
    }
  });
});

describe("parseSiteConfig", () => {
  it("godtar en gyldig konfigurasjon", () => {
    expect(parseSiteConfig(validConfig()).sources).toHaveLength(1);
  });

  describe("en aktiv kilde", () => {
    it("må ha åpen lisens", () => {
      expect(errorFor(validConfig({ sources: [activeSource({ license: "UNKNOWN" })] }))).toContain(
        "åpen lisens",
      );
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

  it.each([
    ["lagring av IP-adresser", { privacy: { ...validConfig().privacy, storeIpAddresses: true } }],
    [
      "navngiving av privatpersoner",
      { editorial: { ...validConfig().editorial, neverNamePrivatePersons: false } },
    ],
    ["visning av kildenes bilder", { editorial: { ...validConfig().editorial, showSourceImages: true } }],
  ])("lar seg ikke konfigurere til å tillate %s", (_name, overrides) => {
    expect(() => parseSiteConfig({ ...validConfig(), ...overrides })).toThrow();
  });
});
