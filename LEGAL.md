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
| Slettingen kjører i hver planlagte jobb før grupperingen og skrivingen, også når innhentingen feiler. Skrivingen sender heller ikke tekst som har passert slettefristen, selv om slettingen ikke har kjørt ennå | `ingest/pipeline.ts`, `generate/run.ts` | ✅ |
| robots.txt (RFC 9309) sjekkes før hver henting, også for mål for omdirigeringer. Kan den ikke leses (5xx, 429, nettverksfeil), hentes ingenting | `ingest/access.ts` | ✅ |
| TDM-reservasjoner sjekkes før hver henting: tdmrep.json, `tdm-reservation`-header og -meta, og sperre for KI-crawlere i robots.txt. tdmrep.json hentes bare når robots.txt tillater det | `ingest/access.ts` | ✅ |
| Reserverer kilden enkeltartikler, lagres bare tittel og lenke for dem, ikke tekst. Kommer reservasjonen senere, fjernes teksten ved neste henting | `ingest/run.ts` | ✅ |
| Bare tekst lagres. HTML, bilder og skript fjernes, og teksten kuttes etter `maxExcerptChars` og `maxTextChars` | `ingest/text.ts` | ✅ |
| Henting av lenkede artikkelsider er avslått for alle kilder. Slås det på, hentes de bare fra kildens egne verter og bare når robots.txt og TDM tillater det | `config/site.config.ts`, `ingest/run.ts` | ✅ |
| Høflig henting: User-Agent med kontaktadresse, betingede forespørsler, minste intervall og størrelsesgrense | `ingest/http.ts` | ✅ |
| Grupperingen analyserer bare tekst som kan analyseres: elementet og kilden er ikke reservert mot tekst- og datautvinning (også reservasjoner funnet etter at elementet ble hentet), kilden er aktiv, og teksten er ikke slettet. Det gjelder nye elementer, elementer i åpne saker som kan sendes til Claude, og ordvektene. Annen tekst analyseres ikke, heller ikke lokalt | `cluster/eligibility.ts` | ✅ |
| Grupperingen sender bare tittel og et kort utdrag (maks 600 tegn) til Claude, og bare for elementer i gråsonen | `cluster/judge.ts` | ✅ |
| Korte, merkede og krediterte sitater (`maxQuoteWords`, til sammen høyst `maxQuotedWordsPerSource` ord fra samme kilde), ellers egne formuleringer. Sitater som er for lange eller ikke står ordrett i kilden (fra fire ord), og ordrekker på mer enn `maxCopiedWords` ord som er like en kilde, stopper publisering. Alle vanlige sitattegn og sitatstrek kontrolleres. Nær-kopier med små endringer, mye sitering fra samme kilde, kopierte navnelister og titler, og sitater som kan være oversatt fra en kilde på et annet språk, flagges for redaktøren | `generate/checks.ts`, `generate/quotes.ts`, promptene | ✅ |
| Artikler bygger bare på kildene, og alle kildene Claude fikk se, lenkes med kildeangivelse fra lisensen (`attribution`). Kildetekst vises aldri for lesere | `generate/run.ts`, `/sak/[slug]` | ✅ |
| Til Claude sendes bare tekst som kan analyseres (samme filter som grupperingen), og bare så mye som trengs (`maxSourceCharsPerItem`, `maxSourceCharsTotal`) | `generate/sources.ts` | ✅ |
| Side der rettighetshavere kan be om fjerning                                               | Kontakt / fjerning           | Fase 7 |

Fakta er ikke opphavsrettslig beskyttet, men formuleringer er det. Derfor lagres bare teksten som trengs for
generering og chat, og bare i en begrenset periode. Et element som fortsatt står i feeden, får ikke ny slettefrist
så lenge innholdet er uendret.

Kildene er åpent lisensiert, så lisensen gir uansett rett til gjenbruk. Vi respekterer likevel reservasjoner mot
tekst- og datautvinning, og tolker en sperre for kjente KI-crawlere i robots.txt som en slik reservasjon.

Innhentingen bruker bare det kildene selv publiserer i RSS-feeder og åpne API-er. Å hente og tolke de lenkede
artikkelsidene (`allowFullTextFetch`) kan regnes som skraping, og er derfor slått av til det er avklart.

## Merking av AI-innhold (EUs AI-forordning art. 50)

- Alle sider viser at innholdet er AI-generert (`src/components/ai-notice.tsx`).
- `Article.aiGenerated` har standardverdien `true`. Den synlige merkingen styres ikke av feltet og vises for alle
  artikler uansett.
- Hver artikkel har synlig merking øverst (`ai.articleLabel`) og en forklaring av hvordan den ble laget (modell,
  kontroller, godkjenning). Merkingen vises for alle artikler og styres ikke av noe felt.
- Maskinlesbar merking: `<meta name="ai-generated" content="true">` i `<head>` på artikkelsiden og forsiden
  (metadata strømmes ikke til `<body>`, se `htmlLimitedBots` i `next.config.ts`), og strukturerte data (schema.org
  `NewsArticle` med `creator` som programvare og kildene i `isBasedOn`).
- Forklaringen av hvordan saken ble laget, sier bare at AI-modereringen kontrollerte teksten når den faktisk gjorde
  det.
- Modell og promptversjon lagres for hver artikkel og hver versjon.
- Merking per svar i chatten kommer i fase 6.
- Grupperingen (fase 3) lager ikke innhold for lesere. Der Claude har avgjort en gruppering, er det merket i admin
  med «Claude: samme sak» eller «Claude: ny sak» og Claudes begrunnelse, og hvilken promptversjon som ble brukt,
  lagres i jobbloggen.

## Medieansvar (medieansvarsloven og e-handelsloven)

- Ansvarlig redaktør står i bunnen av hver side og konfigureres i `editor`. I dette demoprosjektet er feltet en
  tydelig merket plassholder.
- Datamodellen har «Rettet»-merking (`Article.isCorrected`) og en endringslogg (`ArticleRevision`) med hva som
  endret seg og hvorfor. En sak som har en artikkel kan ikke slettes (`onDelete: Restrict`), så publisert innhold
  forsvinner ikke ved en feil. Det avpubliseres med begrunnelse i stedet.
- Grupperingen prioriterer presisjon: i tvilstilfeller blir et element en egen sak heller enn å blandes med en
  annen sak, så en artikkel ikke bygger på kilder om en annen hendelse. Usikre elementer merkes i admin, der
  redaktøren kan flytte dem. Kildene til en sak med artikkel kan ikke flyttes der; det skal skje gjennom
  oppdateringsflyten med endringslogg i fase 5.
- Saker om temaene i `editorial.sensitiveCategories` krever manuell godkjenning. Privatpersoner navngis aldri
  (`neverNamePrivatePersons: true` kan ikke endres). Påstander om enkeltpersoner krever minst
  `minSourcesForPersonClaims` uavhengige kilder. Håndheves slik: en navngitt privatperson stopper publisering
  (fanges av skriverens egen liste når navnet står i teksten, og av modereringen når den er sikker; usikre funn
  flagges for redaktøren). Navn som ikke står i skriverens personliste, flagges. Sensitive temaer flagger alltid
  artikkelen for manuell godkjenning, også når bare modereringen melder dem. Påstander om en person med færre enn
  `minSourcesForPersonClaims` kilder som nevner personen, med ulike utgivere, flagges for redaktøren. Hva en person
  sier i sin offentlige rolle, regnes ikke som en påstand om personen. Skriveren og modereringen bruker samme
  definisjon av offentlig rolle.
- Alle artikler godkjennes av redaktøren før publisering (`manualApproval: "ALL"`). Artikler som bryter faste regler,
  kan ikke godkjennes. Skriverens merknader om hull eller motstrid i kildene flagger artikkelen. Alle publiserte
  artikler kan avpubliseres fra admin med begrunnelse, som føres i endringsloggen. Admin varsler så lenge ansvarlig
  redaktør ikke er utpekt.
- Relative tidsord i kildene («i dag», «i går») regnes om til ukedag eller dato ut fra kildens publiseringstid, så
  artikkelen ikke blir feil når den publiseres senere. Modereringen ser etter feil tidsangivelser.
- Hver artikkel kontrolleres to ganger mot kildene: automatisk (sitater, kopiert tekst, tall, kilder, personer) og av
  en egen AI-moderering. Alle funn lagres og vises for redaktøren.

## Personvern (GDPR, personopplysningsloven) og cookies (ekomloven)

- IP-adresser lagres aldri (`storeIpAddresses: false` kan ikke endres).
- Chatter lagres ikke (`chatLogDays: 0`), og det finnes ingen tabell for dem.
- Ingen analyse-cookies (`analytics: "NONE"`). Bare cookiefri analyse kan slås på.
- Anthropic er oppført som databehandler i `privacy.dataProcessors`. Personvernerklæringen kommer i fase 7.
- Til Claude sendes bare tekst fra kildene, aldri opplysninger om lesere eller brukere. I grupperingen er det bare
  tittel og et kort utdrag, og bare når likheten er i gråsonen. Ved skriving og moderering sendes kildeteksten til
  saken, begrenset av budsjettet i `generation`. API-nøkkelen leses fra miljøet (`.env`), aldri fra
  koden, og testene kaller aldri API-et.
- Ingen sider kan vises i en ramme på et annet nettsted (`X-Frame-Options: DENY` og CSP `frame-ancestors 'none'`),
  så en innlogget redaktør ikke kan lures til å klikke på knapper i en skjult admin-side.
- Admin bruker HTTP Basic Auth uten cookies. Tilgangen sjekkes både i `src/proxy.ts` og i datalaget
  (`requireAdmin()` i `src/lib/admin.ts`). Passordet må være tilfeldig og minst 24 tegn.
