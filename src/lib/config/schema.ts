import { z } from "zod";

/**
 * Skjema for config/site.config.ts.
 *
 * Konfigurasjonen samler alle juridisk relevante innstillinger på ett sted.
 * Skjemaet håndhever regler som ikke skal kunne slås av ved et uhell, for
 * eksempel at en kilde må ha åpen lisens og leste vilkår før den kan være
 * aktiv, og at IP-adresser aldri lagres. Brytes en regel, stopper appen ved
 * oppstart i stedet for å kjøre med ulovlig oppsett.
 */

export const LICENSES = [
  "NLOD-2.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "PUBLIC-DOMAIN",
  "UNKNOWN",
] as const;

/** Lisenser som tillater gjenbruk, også kommersielt, mot kreditering. */
export const OPEN_LICENSES: ReadonlySet<License> = new Set([
  "NLOD-2.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "PUBLIC-DOMAIN",
]);

export type License = (typeof LICENSES)[number];

const isoDate = z.iso.date();

export const sourceConfigSchema = z
  .object({
    /** Stabil nøkkel, brukes til å synkronisere med databasen. */
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug må være kebab-case"),
    name: z.string().min(1),
    publisher: z.string().min(1),
    kind: z.enum(["RSS", "API"]),
    /** Hvordan feeden leses: «rss» (RSS 2.0, RSS 1.0 og Atom) eller et kildespesifikt API. */
    adapter: z.enum(["rss", "stortinget-saker"]),
    /** Adressen som hentes. Kan mangle så lenge kilden ikke er aktiv. */
    feedUrl: z.url({ protocol: /^https$/ }).nullable(),
    homepageUrl: z.url({ protocol: /^https$/ }),
    /** Lenke til kildens egne bruksvilkår eller lisensside. */
    termsUrl: z.url({ protocol: /^https$/ }),
    license: z.enum(LICENSES),
    /** Kort begrunnelse på norsk for hvorfor kilden kan brukes. */
    licenseNote: z.string().min(1),
    /** Kildeangivelsen lisensen krever, slik den vises på siden. */
    attribution: z.string().min(1),
    language: z.enum(["nb", "nn", "en"]),
    status: z.enum(["ACTIVE", "PAUSED", "NEEDS_VERIFICATION"]),
    /** Dato (ÅÅÅÅ-MM-DD) da et menneske sist leste vilkårene. */
    termsReviewedAt: isoDate.nullable(),
    /** Reservasjon mot tekst- og datautvinning (DSM-direktivet art. 4), f.eks. i robots.txt eller tdmrep.json. */
    tdmReservation: z.enum(["NONE_FOUND", "RESERVED", "UNKNOWN"]),
    /** Om innhentingen kan hente siden RSS-en lenker til (krever åpen lisens). */
    allowFullTextFetch: z.boolean(),
    notes: z.string().optional(),
  })
  .superRefine((source, ctx) => {
    const isOpen = OPEN_LICENSES.has(source.license);

    if (source.status === "ACTIVE") {
      if (!isOpen) {
        ctx.addIssue({
          code: "custom",
          path: ["license"],
          message: "en aktiv kilde må ha en åpen lisens",
        });
      }
      if (source.feedUrl === null) {
        ctx.addIssue({
          code: "custom",
          path: ["feedUrl"],
          message: "en aktiv kilde må ha feedUrl",
        });
      }
      if (source.termsReviewedAt === null) {
        ctx.addIssue({
          code: "custom",
          path: ["termsReviewedAt"],
          message: "vilkårene må være lest før kilden kan aktiveres",
        });
      }
      if (source.tdmReservation !== "NONE_FOUND") {
        ctx.addIssue({
          code: "custom",
          path: ["tdmReservation"],
          message: "en aktiv kilde kan ikke ha (eller ha ukjent) TDM-reservasjon",
        });
      }
    }

    if (source.allowFullTextFetch && !isOpen) {
      ctx.addIssue({
        code: "custom",
        path: ["allowFullTextFetch"],
        message: "fulltekst kan bare hentes fra kilder med åpen lisens",
      });
    }
  });

export const siteConfigSchema = z
  .object({
    site: z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      /** Offentlig adresse, brukes i metadata og lenker. */
      url: z.url(),
      language: z.literal("nb"),
    }),

    /** Medieansvarsloven § 4 og e-handelsloven § 8: hvem som har ansvaret. */
    editor: z.object({
      name: z.string().min(1),
      email: z.email(),
      /** true så lenge feltene over er plassholdere. Vises tydelig på siden. */
      isPlaceholder: z.boolean(),
    }),

    retention: z.object({
      /** Antall dager kildetekst (utdrag og brødtekst) lagres før den slettes. */
      sourceTextDays: z.number().int().min(1).max(365),
      /** 0 betyr at chatter ikke lagres i det hele tatt. */
      chatLogDays: z.number().int().min(0).max(30),
      /** Hvor lenge loggen over jobbkjøringer beholdes. */
      jobRunDays: z.number().int().min(1).max(365),
    }),

    editorial: z.object({
      /** ALL: alt godkjennes manuelt. FLAGGED_ONLY: bare saker moderasjonen flagger. */
      manualApproval: z.enum(["ALL", "FLAGGED_ONLY"]),
      /** Temaer som alltid krever manuell godkjenning (Vær Varsom-plakaten). */
      sensitiveCategories: z.array(z.string().min(1)).min(1),
      /** Lengste tillatte direkte sitat fra en kilde, målt i ord. */
      maxQuoteWords: z.number().int().min(0).max(50),
      /** Antall uavhengige kilder som kreves for påstander om enkeltpersoner. */
      minSourcesForPersonClaims: z.number().int().min(1),
      /** Privatpersoner navngis aldri. Kan ikke slås av. */
      neverNamePrivatePersons: z.literal(true),
      /** Kildenes bilder vises aldri. Kan ikke slås av. */
      showSourceImages: z.literal(false),
    }),

    ai: z.object({
      provider: z.literal("Anthropic"),
      model: z.string().min(1),
      /** Synlig merking av AI-generert innhold (EUs AI-forordning art. 50). */
      articleLabel: z.string().min(1),
      chatLabel: z.string().min(1),
    }),

    privacy: z.object({
      /** IP-adresser lagres aldri. Kan ikke slås av. */
      storeIpAddresses: z.literal(false),
      /** Ingen sporing uten samtykke. Bare cookiefri analyse er tillatt. */
      analytics: z.enum(["NONE", "COOKIELESS"]),
      dataProcessors: z
        .array(
          z.object({
            name: z.string().min(1),
            purpose: z.string().min(1),
            location: z.string().min(1),
          }),
        )
        .min(1),
    }),

    /** Regler for høflig og lovlig henting. */
    ingestion: z.object({
      /**
       * Identifiserer tjenesten overfor kildene, med kontaktinformasjon (krav
       * hos bl.a. MET). Første ord før «/» brukes som navn i robots.txt.
       */
      userAgent: z
        .string()
        .regex(/^[A-Za-z0-9-]+\/\S+ /, "må starte med «Navn/versjon »")
        .refine((ua) => /https:\/\/\S+|\S+@\S+/.test(ua), "må inneholde kontaktinformasjon (URL eller e-post)"),
      /**
       * Hvis robots.txt sperrer en av disse KI-crawlerne, tolkes det som en
       * reservasjon mot tekst- og datautvinning, og kilden hoppes over.
       */
      aiCrawlerTokens: z.array(z.string().min(1)).min(1),
      /** Minste tid mellom to hentinger fra samme kilde. */
      minIntervalMinutes: z.number().int().min(5).max(1440),
      /** Antall nyeste elementer fra feeden som behandles per kilde per kjøring. */
      maxItemsPerSource: z.number().int().min(1).max(200),
      /** Eldre elementer hentes ikke. */
      maxItemAgeDays: z.number().int().min(1).max(30),
      /** Lengste utdrag fra feeden som lagres. */
      maxExcerptChars: z.number().int().min(100).max(2000),
      /** Lengste brødtekst som lagres. Resten kastes. */
      maxTextChars: z.number().int().min(500).max(50000),
      requestTimeoutMs: z.number().int().min(1000).max(60000),
      maxResponseBytes: z.number().int().min(10_000).max(10_000_000),
    }),

    sources: z.array(sourceConfigSchema).min(1),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.sources.forEach((source, index) => {
      if (seen.has(source.slug)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", index, "slug"],
          message: `kilden «${source.slug}» er definert flere ganger`,
        });
      }
      seen.add(source.slug);
    });
  });

export type SiteConfigInput = z.input<typeof siteConfigSchema>;
export type SiteConfig = z.output<typeof siteConfigSchema>;
export type SourceConfig = z.output<typeof sourceConfigSchema>;
export type IngestionConfig = SiteConfig["ingestion"];

/** Gir typehjelp i config-filen uten å validere (valideringen skjer i parseSiteConfig). */
export function defineSiteConfig(config: SiteConfigInput): SiteConfigInput {
  return config;
}

export function parseSiteConfig(raw: unknown): SiteConfig {
  const result = siteConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Ugyldig config/site.config.ts:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
