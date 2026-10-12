import { defineSiteConfig } from "@/lib/config/schema";

/**
 * Juridisk og redaksjonell konfigurasjon for AI-nyheter.
 *
 * Alt som har betydning for opphavsrett, personvern, medieansvar og merking
 * av AI-innhold styres herfra. Filen valideres ved oppstart (se
 * src/lib/config/schema.ts), og ugyldige kombinasjoner stopper appen.
 * LEGAL.md forklarer begrunnelsen for hvert tiltak.
 */
export default defineSiteConfig({
  site: {
    name: "AI-nyheter",
    description:
      "Nøytrale nyhetssaker skrevet av kunstig intelligens, kun basert på åpne og lenkede kilder.",
    url: "http://localhost:3000",
    language: "nb",
  },

  editor: {
    name: "Ikke utpekt",
    email: "redaktor@example.com",
    isPlaceholder: true,
  },

  retention: {
    sourceTextDays: 30,
    chatLogDays: 0,
    jobRunDays: 90,
  },

  editorial: {
    manualApproval: "ALL",
    sensitiveCategories: [
      "kriminalitet",
      "ulykker",
      "helse",
      "dødsfall",
      "selvmord",
      "barn og unge",
      "rettssaker",
      "etnisitet og religion",
      "seksuell legning",
    ],
    maxQuoteWords: 20,
    minSourcesForPersonClaims: 2,
    neverNamePrivatePersons: true,
    showSourceImages: false,
  },

  ai: {
    provider: "Anthropic",
    model: "claude-sonnet-5-5",
    articleLabel:
      "AI-generert: Denne artikkelen er skrevet av kunstig intelligens og bygger kun på kildene som er lenket nedenfor.",
    chatLabel:
      "AI-generert: Svarene skrives av kunstig intelligens og bygger kun på kildene til denne saken.",
  },

  privacy: {
    storeIpAddresses: false,
    analytics: "NONE",
    dataProcessors: [
      {
        name: "Anthropic PBC",
        purpose: "Skriving og kontroll av artikler og svar i chatten via Claude API",
        location: "USA",
      },
    ],
  },

  /**
   * Kilder. En kilde hentes bare når status er ACTIVE, og skjemaet krever da
   * åpen lisens, leste vilkår og at det ikke er funnet TDM-reservasjon.
   * robots.txt sjekkes i tillegg automatisk før hver innhenting.
   */
  sources: [
    {
      slug: "stortinget-saker",
      name: "Stortinget – saker",
      publisher: "Stortinget",
      kind: "API",
      // Innhentingen legger til gjeldende sesjonid (f.eks. 2026-2027).
      feedUrl: "https://data.stortinget.no/eksport/saker?format=json",
      homepageUrl: "https://data.stortinget.no/",
      termsUrl: "https://data.stortinget.no/om-datatjenesten/bruksvilkar/",
      license: "NLOD-2.0",
      licenseNote:
        "Bruksvilkårene viser til gjeldende Norsk lisens for offentlige data (NLOD). Stortinget skal oppgis som kilde, og data skal ikke presenteres villedende eller forvrengt. Grense: 100 API-kall per minutt.",
      attribution: "Kilde: Stortinget (data.stortinget.no), NLOD",
      language: "nb",
      status: "NEEDS_VERIFICATION",
      termsReviewedAt: null,
      tdmReservation: "UNKNOWN",
      allowFullTextFetch: false,
      notes:
        "Vilkårene er oppsummert fra websøk 12.10.2026, men ikke lest direkte på termsUrl fordi utviklingsmiljøet blokkerte domenet. robots.txt er ikke sjekket.",
    },
    {
      slug: "ssb",
      name: "SSB – nyheter og publiseringer",
      publisher: "Statistisk sentralbyrå",
      kind: "RSS",
      feedUrl: "https://www.ssb.no/rss/",
      homepageUrl: "https://www.ssb.no/",
      termsUrl: "https://www.ssb.no/diverse/lisens",
      license: "CC-BY-4.0",
      licenseNote:
        "SSB publiserer under CC BY 4.0, også til kommersiell bruk, mot kildeangivelse. Bilder og taushetsbelagte data er ikke omfattet.",
      attribution: "Kilde: Statistisk sentralbyrå (SSB), CC BY 4.0",
      language: "nb",
      status: "NEEDS_VERIFICATION",
      termsReviewedAt: null,
      tdmReservation: "UNKNOWN",
      allowFullTextFetch: true,
      notes:
        "Lisensen er oppsummert fra websøk 12.10.2026, men ikke lest direkte på termsUrl. Feed-adressen for norsk er hentet fra en tredjepartsoversikt. SSB dokumenterer den engelske feeden https://www.ssb.no/en/rss/ og temafeeder under /rss/<tema>.",
    },
    {
      slug: "met-farevarsler",
      name: "MET Norge – farevarsler (MetAlerts)",
      publisher: "Meteorologisk institutt",
      kind: "RSS",
      feedUrl: "https://api.met.no/weatherapi/metalerts/2.0/current.xml",
      homepageUrl: "https://api.met.no/weatherapi/metalerts/2.0/documentation",
      termsUrl: "https://api.met.no/doc/TermsOfService",
      license: "NLOD-2.0",
      licenseNote:
        "Data fra MET er lisensiert under NLOD 2.0 og CC BY 4.0 og krever kreditering. API-et krever en identifiserende User-Agent med kontaktinformasjon og ber om at uendrede data ikke hentes gang på gang.",
      attribution: "Data fra MET Norge, NLOD 2.0 / CC BY 4.0",
      language: "nb",
      status: "NEEDS_VERIFICATION",
      termsReviewedAt: null,
      tdmReservation: "UNKNOWN",
      allowFullTextFetch: false,
      notes:
        "Vilkårene er oppsummert fra websøk 12.10.2026, men ikke lest direkte på termsUrl. Feeden inneholder hele varselteksten, så lenkede sider trengs ikke.",
    },
    {
      slug: "eu-kommisjonen",
      name: "EU-kommisjonen – pressemeldinger",
      publisher: "Europakommisjonen",
      kind: "RSS",
      feedUrl: null,
      homepageUrl: "https://ec.europa.eu/commission/presscorner/home/en",
      termsUrl: "https://commission.europa.eu/legal-notice_en",
      license: "CC-BY-4.0",
      licenseNote:
        "Gjenbruk etter beslutning 2011/833/EU, normalt CC BY 4.0 med kreditering og merking av endringer. Bilder er © EU og materiale fra tredjeparter er unntatt.",
      attribution: "Kilde: Europakommisjonen, CC BY 4.0",
      language: "en",
      status: "NEEDS_VERIFICATION",
      termsReviewedAt: null,
      tdmReservation: "UNKNOWN",
      allowFullTextFetch: false,
      notes:
        "Fant ingen offisiell RSS-feed for Press Corner. Det må også bekreftes at pressemeldingene er omfattet av CC BY 4.0.",
    },
    {
      slug: "regjeringen",
      name: "Regjeringen – pressemeldinger",
      publisher: "Regjeringen",
      kind: "RSS",
      feedUrl:
        "https://www.regjeringen.no/no/rss/Rss/2581966/?documentType=aktuelt/nyheter&owner=709",
      homepageUrl: "https://www.regjeringen.no/",
      termsUrl: "https://www.regjeringen.no/no/om-nettstedet/",
      license: "UNKNOWN",
      licenseNote:
        "Statens retningslinjer anbefaler NLOD eller CC BY for offentlige data, men vi har ikke funnet en uttrykkelig lisens for tekstene på regjeringen.no. Bilder har egne vilkår og brukes ikke.",
      attribution: "Kilde: regjeringen.no",
      language: "nb",
      status: "NEEDS_VERIFICATION",
      termsReviewedAt: null,
      tdmReservation: "UNKNOWN",
      allowFullTextFetch: false,
      notes: "Feed-adressen er fra en eldre tredjepartsoversikt og må bekreftes.",
    },
  ],
});
