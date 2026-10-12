import type { SiteConfigInput } from "@/lib/config/schema";

type SourceInput = SiteConfigInput["sources"][number];

/** En gyldig, aktiv kilde som testene kan endre på. */
export function activeSource(overrides: Partial<SourceInput> = {}): SourceInput {
  return {
    slug: "testkilde",
    name: "Testkilde",
    publisher: "Testutgiver",
    kind: "RSS",
    feedUrl: "https://example.no/rss",
    homepageUrl: "https://example.no/",
    termsUrl: "https://example.no/vilkar",
    license: "CC-BY-4.0",
    licenseNote: "Åpen lisens.",
    attribution: "Kilde: Testutgiver, CC BY 4.0",
    language: "nb",
    status: "ACTIVE",
    termsReviewedAt: "2026-10-01",
    tdmReservation: "NONE_FOUND",
    allowFullTextFetch: false,
    ...overrides,
  };
}

/** En gyldig konfigurasjon med én aktiv kilde. */
export function validConfig(overrides: Partial<SiteConfigInput> = {}): SiteConfigInput {
  return {
    site: {
      name: "Test",
      description: "Testnettsted",
      url: "http://localhost:3000",
      language: "nb",
    },
    editor: { name: "Redaktør", email: "redaktor@example.no", isPlaceholder: false },
    retention: { sourceTextDays: 30, chatLogDays: 0, jobRunDays: 90 },
    editorial: {
      manualApproval: "ALL",
      sensitiveCategories: ["kriminalitet"],
      maxQuoteWords: 20,
      minSourcesForPersonClaims: 2,
      neverNamePrivatePersons: true,
      showSourceImages: false,
    },
    ai: {
      provider: "Anthropic",
      model: "claude-sonnet-5-5",
      articleLabel: "AI-generert artikkel",
      chatLabel: "AI-generert svar",
    },
    privacy: {
      storeIpAddresses: false,
      analytics: "NONE",
      dataProcessors: [{ name: "Anthropic PBC", purpose: "Generering", location: "USA" }],
    },
    sources: [activeSource()],
    ...overrides,
  };
}
