# Juridiske tiltak

Dette dokumentet forklarer hvilke tiltak AI-nyheter har for å følge norsk lov og EØS-regler, og hvorfor. Alle
innstillingene ligger i [`config/site.config.ts`](config/site.config.ts) og valideres ved oppstart av
[`src/lib/config/schema.ts`](src/lib/config/schema.ts). Ugyldige kombinasjoner stopper appen.

Dokumentet utvides i hver fase. Det er ikke juridisk rådgivning.

## Opphavsrett (åndsverkloven og EUs opphavsrettsdirektiv)

| Tiltak                                                                                     | Hvor                         | Status |
| ------------------------------------------------------------------------------------------ | ---------------------------- | ------ |
| Kun kilder med åpen lisens (NLOD, CC BY, CC0) kan aktiveres                                | `schema.ts`                  | ✅     |
| En kilde kan ikke aktiveres før et menneske har lest vilkårene (`termsReviewedAt`). Ingen kilder har det ennå | `schema.ts` | ✅ |
| En kilde med reservasjon mot tekst- og datautvinning, eller ukjent status, kan ikke aktiveres | `schema.ts`               | ✅     |
| Lenkede sider kan bare hentes fra kilder med åpen lisens (`allowFullTextFetch`)           | `schema.ts`                  | ✅     |
| Kildenes bilder vises aldri (`showSourceImages: false` kan ikke endres)                    | `schema.ts`                  | ✅     |
| Kildetekst slettes etter `retention.sourceTextDays` (30 dager). Tittel og URL beholdes for kildelisten | `retention.ts`   | ✅     |
| En kortere sletteperiode gjelder også tekst som allerede er lagret                         | `retention.ts`               | ✅     |
| robots.txt og TDM-reservasjoner sjekkes automatisk før hver innhenting                     | Innhenting                   | Fase 2 |
| Korte, merkede og krediterte sitater (`maxQuoteWords`), ellers egne formuleringer          | Generering og moderasjon     | Fase 4 |
| Side der rettighetshavere kan be om fjerning                                               | Kontakt / fjerning           | Fase 7 |

Fakta er ikke opphavsrettslig beskyttet, men formuleringer er det. Derfor lagres bare teksten som trengs for
generering og chat, og bare i en begrenset periode.

## Merking av AI-innhold (EUs AI-forordning art. 50)

- Alle sider viser at innholdet er AI-generert (`src/components/ai-notice.tsx`).
- `Article.aiGenerated` har standardverdien `true`. Den synlige merkingen styres ikke av feltet og vises for alle
  artikler uansett.
- Merking per artikkel og per svar i chatten, og maskinlesbar merking i metadata, kommer i fase 4 og 6.

## Medieansvar (medieansvarsloven og e-handelsloven)

- Ansvarlig redaktør står i bunnen av hver side og konfigureres i `editor`. I dette demoprosjektet er feltet en
  tydelig merket plassholder.
- Datamodellen har «Rettet»-merking (`Article.isCorrected`) og en endringslogg (`ArticleRevision`) med hva som
  endret seg og hvorfor. En sak som har en artikkel kan ikke slettes (`onDelete: Restrict`), så publisert innhold
  forsvinner ikke ved en feil. Det avpubliseres med begrunnelse i stedet.
- Saker om temaene i `editorial.sensitiveCategories` krever manuell godkjenning. Privatpersoner navngis aldri
  (`neverNamePrivatePersons: true` kan ikke endres). Påstander om enkeltpersoner krever minst
  `minSourcesForPersonClaims` uavhengige kilder. Håndheves i moderasjonssteget i fase 4.

## Personvern (GDPR, personopplysningsloven) og cookies (ekomloven)

- IP-adresser lagres aldri (`storeIpAddresses: false` kan ikke endres).
- Chatter lagres ikke (`chatLogDays: 0`), og det finnes ingen tabell for dem.
- Ingen analyse-cookies (`analytics: "NONE"`). Bare cookiefri analyse kan slås på.
- Anthropic er oppført som databehandler i `privacy.dataProcessors`. Personvernerklæringen kommer i fase 7.
- Admin bruker HTTP Basic Auth uten cookies. Tilgangen sjekkes både i `src/proxy.ts` og i datalaget
  (`requireAdmin()` i `src/lib/admin.ts`). Passordet må være tilfeldig og minst 24 tegn.
