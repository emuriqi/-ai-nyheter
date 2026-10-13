import type { SiteConfigInput } from "@/lib/config/schema";

type SourceInput = SiteConfigInput["sources"][number];

/** En gyldig, aktiv kilde som testene kan endre på. */
export function activeSource(overrides: Partial<SourceInput> = {}): SourceInput {
  return {
    slug: "testkilde",
    name: "Testkilde",
    publisher: "Testutgiver",
    kind: "RSS",
    adapter: "rss",
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
    ingestion: {
      userAgent: "AI-nyheter-test/1.0 (+https://example.no/kontakt)",
      aiCrawlerTokens: ["ClaudeBot", "GPTBot"],
      minIntervalMinutes: 30,
      maxItemsPerSource: 50,
      maxItemAgeDays: 7,
      maxExcerptChars: 300,
      maxTextChars: 2000,
      requestTimeoutMs: 5000,
      maxResponseBytes: 100_000,
    },
    clustering: {
      storyWindowHours: 72,
      maxStoryHours: 168,
      sameStoryThreshold: 0.4,
      borderlineThreshold: 0.15,
      useClaudeForBorderline: false,
      maxClaudeChecksPerRun: 5,
      idfWindowDays: 30,
      maxItemsPerRun: 500,
    },
    sources: [activeSource()],
    ...overrides,
  };
}
