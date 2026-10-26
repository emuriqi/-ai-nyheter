# AI-nyheter

En nyhetsside der kunstig intelligens skriver nøytrale saker basert **kun** på åpent lisensierte kilder. Siden henter
nyheter fra RSS og åpne API-er, grupperer kildeartikler som handler om det samme, skriver én artikkel per sak med
lenker til alle kildene, oppdaterer artikkelen med synlig endringslogg når nye kilder kommer, og lar leseren chatte
med AI-en om hver sak. Chatten svarer bare ut fra kildene til den saken.

Prosjektet er laget for å drives etter norsk lov og EØS-regler (opphavsrett, medieansvar, personvern og EUs
AI-forordning). Juridiske hensyn styrer designet, og alle juridisk relevante innstillinger ligger i én fil:
[`config/site.config.ts`](config/site.config.ts). Se [LEGAL.md](LEGAL.md) for tiltakene og begrunnelsen.

> Porteføljeprosjekt. Siden kjøres lokalt og er ikke publisert. Alle kildene står foreløpig som «Må verifiseres»,
> så ingenting hentes før et menneske har lest vilkårene deres (se [Kilder](#kilder)).

## Status

| Fase | Innhold                                       | Status    |
| ---- | --------------------------------------------- | --------- |
| 1    | Oppsett, datamodell og juridisk konfigurasjon | ✅ Ferdig |
| 2    | Innhenting fra RSS og åpne API-er             | ✅ Ferdig |
| 3    | Gruppering av kildeartikler til saker         | ✅ Ferdig |
| 4    | Artikkelgenerering med moderasjonssteg        | ✅ Ferdig |
| 5    | Oppdatering og endringslogg                   | Planlagt  |
| 6    | Chat per sak                                  | Planlagt  |
| 7    | Juridiske sider og personvern                 | Planlagt  |
| 8    | Design og polering                            | Planlagt  |

## Teknologi

- **Next.js 16** (App Router, Cache Components) med TypeScript og Tailwind CSS 4
- **Prisma 7** med SQLite via `better-sqlite3`-adapteren. Bytte til Postgres krever ny provider i
  `prisma/schema.prisma` og ny adapter i `src/lib/db.ts`.
- **zod** for validering av konfigurasjonen
- **Vitest** for tester
- **Claude API** (`claude-sonnet-5-5`) via Anthropics offisielle TypeScript-SDK (`@anthropic-ai/sdk`). Brukes i
  grupperingen fra fase 3 og til skriving og moderering av artikler fra fase 4. Uten nøkkel virker innhenting og
  gruppering, men ingen artikler skrives.

## Kom i gang

Krever Node.js 22 eller nyere.

```bash
cp .env.example .env       # sett ADMIN_TOKEN for å bruke /admin, f.eks. med: openssl rand -base64 32
                           # ANTHROPIC_API_KEY er valgfri (se Gruppering)
npm install                # genererer også Prisma-klienten
npm run db:deploy          # lager prisma/dev.db og kjører migreringene
npm run db:seed            # synkroniserer kildene fra config/site.config.ts
npm run dev                # http://localhost:3000
```

Kjør innhentingen med `npm run ingest`, med knappen «Kjør innhenting nå» i admin, eller fra en cron-jobb:

```bash
# CRON_SECRET settes i .env (tilfeldig, minst 24 tegn). Serveren leser .env ved oppstart,
# men skallet ditt gjør ikke det, så hent verdien inn først:
CRON_SECRET=$(grep '^CRON_SECRET=' .env | cut -d= -f2- | tr -d '"')
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/ingest
```

Admin ligger på <http://localhost:3000/admin>. Brukernavnet er `admin`, og passordet er `ADMIN_TOKEN` fra `.env`.
Passordet må være tilfeldig og minst 24 tegn, ellers er admin avslått. Tilgangen sjekkes både i `src/proxy.ts` og i
datalaget (`src/lib/admin.ts`), siden en sjekk i layouten ikke hindrer at sidens data sendes til nettleseren.

## Arkitektur

```
            config/site.config.ts  (kilder, lisenser, sletteperiode, godkjenningskrav)
                       │  valideres med zod ved oppstart
                       ▼
 RSS / åpne API-er ─► Innhenting ─► SourceItem ─► Gruppering ─► Story
                      robots.txt,                 TF-IDF lokalt,  │
                      TDM-sjekk                   Claude i        │
                                                  gråsonen        ▼
                                    Skriving (Claude) ─► Kontroller ─► Article + ArticleRevision
                                                         automatiske     │  til godkjenning i admin
                                                         + AI-moderering ▼
                       Slettejobb: fjerner kildetekst       /sak/[slug] med kilder, AI-merking
                       etter N dager (tittel og URL         og endringslogg (chat i fase 6)
                       beholdes for kildelisten)
```

### Innhenting (fase 2)

`npm run ingest`, cron-ruten og admin-knappen kjører samme jobb (`src/lib/ingest/pipeline.ts`):

1. **Synkroniser kildene** fra `config/site.config.ts` til databasen.
2. **Hent fra hver aktiv kilde.** Bare kilder med status `ACTIVE` hentes, og skjemaet krever åpen lisens og leste
   vilkår for det. For hver kilde:
   - **robots.txt** leses etter RFC 9309. Kan den ikke leses (5xx, 429 eller nettverksfeil), hentes ingenting.
   - **Reservasjon mot tekst- og datautvinning** sjekkes på tre måter: `/.well-known/tdmrep.json` (TDMRep, første
     regel som matcher gjelder), headeren `tdm-reservation: 1`, og om robots.txt sperrer kjente KI-crawlere
     (`aiCrawlerTokens`). Reserverer kilden feeden, hoppes kilden over. Reserverer den enkeltartikler, lagres bare
     tittel og lenke for dem. Funnene vises i admin.
   - **Feeden hentes høflig**: identifiserende User-Agent med kontaktadresse, betingede forespørsler
     (`If-None-Match` / `If-Modified-Since`), minste intervall mellom hentinger, tidsavbrudd, maks størrelse og
     omdirigeringer bare innenfor samme vert. Hvert mål for en omdirigering sjekkes også mot robots.txt og TDM.
   - **Feeden leses** som RSS 2.0, RSS 1.0 eller Atom, eller med en egen adapter for Stortingets API. HTML gjøres om
     til ren tekst, og bilder og skript fjernes.
   - **Lagring**: nye elementer får slettedato. Uendrede elementer røres ikke, så slettefristen ikke forlenges.
     Endret innhold lagres på nytt. Elementer eldre enn `maxItemAgeDays` hentes ikke, bare de `maxItemsPerSource`
     nyeste elementene behandles, og teksten kuttes etter `maxExcerptChars` og `maxTextChars`.
   - **Fulltekst fra artikkelsiden** er avslått for alle kilder. Det kan slås på per kilde med `allowFullTextFetch`
     (krever åpen lisens), og hentes da bare fra kildens egne verter og bare når robots.txt og TDM-reglene
     tillater det. Hovedteksten hentes ut med Mozillas Readability.
3. **Slett utløpt kildetekst** og gamle jobblogger, før teksten kan brukes videre.
4. **Grupper nye elementer i saker** (se under).
5. **Skriv artikler** for saker som er klare (se «Skriving og moderering»).

Hver kjøring logges som en `JobRun` med resultat per kilde. To kjøringer i samme prosess kan ikke gå samtidig, og på
tvers av prosesser (f.eks. `npm run ingest` mens serveren kjører) reserveres hver kilde atomisk i databasen, så samme
kilde ikke hentes to ganger innenfor minste intervall.

### Gruppering (fase 3)

Hvert nytt element legges i den åpne saken det ligner mest på, eller starter en ny sak
(`src/lib/cluster/`). Elementene behandles i publiseringsrekkefølge, som i klassisk «single-pass»-gruppering fra
forskningen på Topic Detection and Tracking.

1. **Teksten gjøres om til ord.** Tittel (dobbel vekt), utdrag og starten av brødteksten (halv vekt) deles i ord,
   norske stoppord fjernes, og ordene stammes med Snowball-stemmeren for norsk («regjeringen» og «regjeringa» blir
   «regjering»). Ledetekster i faktalister (som «Status:» og «Komité:» fra Stortinget) fjernes.
2. **Ordene vektes med TF-IDF** over elementene fra de siste `idfWindowDays` dagene, så ord som står overalt
   («regjeringen», «prosent») teller lite og sjeldne ord som stedsnavn teller mye.
3. **Likheten måles med cosinus** mot hvert element i de åpne sakene. En sak er åpen så lenge det nye elementet er
   publisert innenfor `storyWindowHours` (72) fra sakens første eller siste kilde, og saken ikke ville dekket mer enn
   `maxStoryHours` (7 døgn). Grensen hindrer at ulike hendelser på samme sted lenkes sammen til én sak som aldri
   lukkes.
4. **Avgjørelsen** følger to grenser i `config/site.config.ts`:
   - likhet fra `sameStoryThreshold` (0,40) med et element fra **en annen kilde** i den mest like saken: samme sak
   - under `borderlineThreshold` (0,15): ny sak
   - alt imellom, og høy likhet som bare er med elementer fra samme kilde, er en gråsone. En kilde bruker ofte
     faste maler, så to ulike farevarsler for samme fylke kan ligne mer enn to omtaler av samme hendelse. I gråsonen
     avgjør Claude (`prompts/cluster-same-story.md`) hvis `ANTHROPIC_API_KEY` er satt. Claude får bare tittel og et
     kort utdrag (maks 600 tegn) fra det nye elementet og fra opptil tre kandidatsaker (de fire nyeste elementene i
     hver), og svarer med strukturert output der API-et bare tillater A, B, C eller «ingen», pluss en kort
     begrunnelse. Uten nøkkel, ved feil, avslag eller ugyldig svar, eller når grensen `maxClaudeChecksPerRun` er
     nådd, blir elementet en egen sak og merkes som usikkert.

Grensene er valgt mot et syntetisk testkorpus i to deler, skrevet av flere uavhengige KI-agenter i sju kildestiler
(farevarsel, etat, departement, Stortinget, SSB, kommune, nyhetsbyrå):

- `tests/fixtures/cluster-corpus.json`: 48 elementer om 19 hendelser, med bevisst vanskelige par: to farevarsler
  samme dag, fugleinfluensa i to fylker, to lovforslag fra samme departement som Stortinget mottok samme dag, og KPI
  for to måneder.
- `tests/fixtures/cluster-corpus-hard.json`: 18 elementer om 9 hendelser til, laget etter en kritisk gjennomgang:
  vind, regn og snø i Møre og Romsdal i samme uke, et nytt vindvarsel uken etter, to ulike tilbakekallinger fra
  Mattilsynet, utenrikshandel og KPI fra SSB samme morgen, og oppfølginger fra samme kilde (oppgradert flomvarsel,
  utvidet tilbakekalling).

Målt med `npm run eval:cluster`:

| Korpus                          | Oppsett                          | Presisjon | Dekning | Saker (fasit)           |
| ------------------------------- | -------------------------------- | --------- | ------- | ----------------------- |
| Hovedkorpuset (48)              | Uten Claude                      | 100 %     | 50 %    | 29 (19)                 |
| Hovedkorpuset (48)              | Med en perfekt dommer i gråsonen | 100 %     | 100 %   | 19 (19), 17 vurderinger |
| Med vanskelige tilfeller (66)   | Uten Claude                      | 100 %     | 51 %    | 41 (28)                 |
| Med vanskelige tilfeller (66)   | Med en perfekt dommer i gråsonen | 100 %     | 100 %   | 28 (28), 26 vurderinger |

Presisjon er andelen par i samme sak som virkelig hører sammen, og dekning er andelen par som hører sammen og ble
lagt sammen. Grensene prioriterer presisjon: å blande to saker gir feil fakta i artikkelen, mens en sak som er
delt i to bare gir et ekstra utkast som redaktøren ser før publisering. Den perfekte dommeren kjenner fasiten og
viser hva gråsonen kan gi. Hvor nær Claude kommer, måles med `npm run eval:cluster -- --claude` (krever nøkkel, om
lag 45 korte kall). Korpuset er lite og skrevet for testen, så tallene sier mer om de vanskelige tilfellene enn om
ekte trafikk. Høyeste likhet mellom to ulike saker fra ulike kilder i korpuset er 0,32, mot grensen 0,40.

Bare tekst som kan analyseres, brukes noe sted i grupperingen: elementet og kilden er ikke reservert mot tekst- og
datautvinning, kilden er aktiv, og teksten er ikke slettet. Det gjelder nye elementer, elementene i åpne saker som
kan sendes til Claude, og ordvektene (`src/lib/cluster/eligibility.ts`).

Jobben tåler at andre endrer data underveis. Er et element allerede gruppert av en annen prosess, eller er saken
det skulle til slettet eller tatt av en samtidig slug, lagres ingenting for det elementet, og det tas i neste
kjøring. Transaksjonene kaster ikke ved slike forventede utfall, men rydder opp selv: SQLite-adapteren deler én
tilkobling i prosessen, så en tilbakerulling kunne ellers tatt med seg samtidige skrivinger fra andre oppgaver. En
feil i grupperingen stopper ikke slettingen av kildetekst, som alltid kjører, men cron-ruten svarer da 500 og
`npm run ingest` avslutter med feilkode, så overvåking fanger det opp.

Admin-siden **Saker** viser hver sak med kildene, hvordan hvert element ble gruppert, likheten og Claudes
begrunnelse. Usikre elementer er merket og viser saken de lignet mest på, med en knapp for å flytte dem dit. Et
element kan også skilles ut til en egen sak, og en flytting kan angres med «Flytt tilbake». Saken som blir igjen,
får ny arbeidstittel hvis elementet den kom fra, ble flyttet ut. Det går ikke an å flytte mens grupperingen kjører.
Har en gruppering stoppet uten å bli ferdig (for eksempel ved en omstart), viser siden det, med en knapp for å
markere den som avbrutt. Saker som har fått en artikkel, kan ikke endres her; det skal gå gjennom
oppdateringsflyten med endringslogg (fase 5).

**Kjent begrensning.** Svært korte, malpregede tekster fra *ulike* kilder om ulike hendelser på samme sted kan
ligne nok til å slås sammen automatisk, for eksempel to ettlinjes farevarsler for samme fylke med ulik fare. I
korpuset, der utdragene er realistisk lange, er høyeste likhet mellom ulike saker fra ulike kilder 0,32, men med
bare titler kan den komme over 0,40. Regelen om samme kilde og taket på 7 døgn begrenser skaden, og redaktøren
kan skille ut elementer i admin. Alle artikler krever uansett manuell godkjenning før publisering.

Kall til Claude bruker `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`): hvis modellen avviser en
forespørsel, kjører API-et den på nytt med reservemodellen Anthropic anbefaler for den typen avslag, i samme kall.
Hver kjøring lagrer antall kall og tokens i jobbloggen, også for svar som ikke kunne brukes.

### Skriving og moderering (fase 4)

Etter grupperingen skrives artikler for saker som er klare (`src/lib/generate/`):

1. **Hvilke saker.** Saker uten artikkel, med minst `minSourcesPerStory` kilder som kan analyseres, som ikke har
   fått nye kilder de siste `settleMinutes` minuttene (målt både fra kildenes tid og fra når de ble lagt i saken,
   så en kilde som hentes sent, også gir ventetid), og som startet for mindre enn `maxStoryAgeHours` timer siden.
   Høyst `maxArticlesPerRun` per kjøring, og en sak gis opp etter `maxAttemptsPerStory` mislykkede forsøk. Saker
   som ikke er forsøkt før, tas først, så en sak som feiler, ikke stenger for de andre.
2. **Kildene.** Bare tekst som kan analyseres (samme filter som grupperingen) og som ikke passerer
   sletteperioden før skrivingen og modereringen er ferdig (20 minutter). Kildene nummereres K1, K2 … i tidsrekkefølge, med utgiver, språk og publiseringstid i norsk tid,
   og kuttes etter `maxSourceCharsPerItem` og `maxSourceCharsTotal`. Kuttede kilder merkes `avkortet="ja"`. Meldingen
   starter med når artikkelen skrives, så relative tidsord («i dag», «i går») kan regnes om. Teksten kan ikke lage
   egne tagger i meldingen, og prompten sier at den er data, ikke instruksjoner.
3. **Skriving.** Claude (`prompts/article-write.md`) skriver tittel, ingress og brødtekst på bokmål, og fyller ut
   kategori, sensitive temaer, personer (rolle, om artikkelen sier noe *om* personen eller bare gjengir hva den sier
   i sin rolle, og hvilke kilder som nevner den), hvilke kilder artikkelen bygger på, og merknader om usikkerhet.
   Svaret er strukturert output med JSON-skjema (kategorier og sensitive temaer som enum). Kildehenvisninger som
   «[K1]» fjernes fra teksten før kontrollene.
4. **Automatiske kontroller** (`checks.ts`, `quotes.ts`, `numbers.ts`), uavhengig av Claude:
   - direkte sitater i «», “”, „“, ‹›, ‘’ eller "", og avsnitt med sitatstrek («– …, sier X»), også over flere
     avsnitt og med sitater i sitatet: lengre enn `maxQuoteWords` ord, ikke ordrett i en kilde (delene rundt en
     utelatelse […] eller et innskudd i klammer må stå i samme rekkefølge, og redaktøren bes sjekke at meningen er
     den samme), og til sammen mer enn `maxQuotedWordsPerSource` ord fra samme kilde
   - ordrekker på mer enn `maxCopiedWords` ord som er like en kilde utenfor sitat, og avsnitt der minst halvparten
     av ordrekkene på fire ord er like én kilde (nær-kopi med små endringer)
   - tall som ikke står i kildene, også tall skrevet med ord («tre»), med tusenskille, i millioner (som må ha
     samme størrelse som i kilden), som datoer og som klokkeslett («kl.», «klokka», «klokken»). Engelske kilder
     leses med engelske tallord, tusenskille og datoer. Datoer godtas dagen før, samme dag og dagen etter at en
     kilde ble publisert, regnet i kalenderdager i norsk tid
   - kilder som ikke finnes, navngitte privatpersoner (navnet må stå i teksten), navn som ser ut som personer, men
     ikke står i personlisten, og påstander om personer med færre enn `minSourcesForPersonClaims` uavhengige kilder
     (kilder som nevner personen, med ulike utgivere)
   - lenker, HTML, lengde og kildenøkler som står igjen i teksten («ifølge K2»)
5. **AI-moderering.** Et eget kall med egen prompt (`prompts/article-moderate.md`) sammenligner artikkelen setning
   for setning med kildene og rapporterer udokumenterte påstander, feil gjengivelser (også feil tidsangivelser),
   tall og sitater uten kilde, kopiert tekst, privatpersoner, sensitive temaer, spekulasjon og ubalanse.
6. **Vurdering.** Funnene samles med alvorsgrad. *Blokkerer* (for langt eller oppdiktet sitat på minst fire ord,
   kopiert tekst, navngitt privatperson, ukjent kilde) betyr at artikkelen ikke kan publiseres. *Høy* og *middels*
   flagger artikkelen for redaktøren. Sensitive temaer (Vær Varsom) flagger alltid, også når bare moderatoren
   melder dem, og det samme gjør skriverens merknader om usikkerhet og en moderering som ikke kunne kjøre. Et
   privatperson-funn fra moderatoren stopper publisering bare når moderatoren er sikker (alvor høy); ellers
   vurderer redaktøren. Med `manualApproval: "ALL"` (standard) går alt til godkjenning; med `"FLAGGED_ONLY"`
   publiseres bare artikler uten funn som krever vurdering (bare funn med alvor lav eller info) automatisk.
7. **Lagring.** Artikkel, første versjon (`ArticleRevision`), alle kildene Claude fikk se (`RevisionSource`) og
   modereringen (`ModerationReview` med alle funn) lagres i én transaksjon, sammen med modell og promptversjon. Er
   kildene til saken flyttet mens artikkelen ble skrevet, lagres ingenting, og saken skrives på nytt i neste
   kjøring.

Feil hos Claude API som ikke gjelder saken, stopper kjøringen: ugyldig nøkkel, manglende tilgang, brukt opp
kreditt, feil i oppsettet (for eksempel en beta organisasjonen ikke har), overbelastning, for mange kall og
nettverksfeil. Forsøket telles ikke, saken merkes med feilen og tas sist i neste kjøring, jobben merkes som
feilet, og cron-ruten svarer 500. Feil som kan gjelde selve saken (avslag, svar som ikke kan tolkes, og svar som
ikke kom innen tidsgrensen) teller som forsøk. Hvert kall har en tidsgrense på 5 minutter og ett nytt forsøk, og
kjøringen starter ikke på nye saker etter 40 minutter, så den blir ferdig lenge før en annen prosess kan regne den
som avbrutt.

Admin-siden **Godkjenning** viser hver artikkel med funnene gruppert («Hindrer publisering», «Må vurderes», «Til
orientering»), teksten og kildene. Redaktøren kan godkjenne og publisere, avvise med begrunnelse, eller slette
utkastet så saken skrives på nytt. «Skriv på nytt» sletter ikke utkastet hvis saken ikke ville blitt skrevet igjen
(skriving ikke satt opp, for få kilder, eller mindre enn tre timer igjen før aldersgrensen, så neste kjøring rekker
den). Publiserte artikler kan avpubliseres med begrunnelse; det føres som en ny versjon i endringsloggen. Avviste og
publiserte artikler vises side for side, så alle kan nås, og siden åpnes på samme sted etter en handling. Saker
der skrivingen feilet, vises med årsak og en knapp for å prøve igjen (for eksempel etter at nøkkelen er rettet).
Flyttes kildene til en sak med et upublisert utkast (under Saker), slettes utkastet og skrives på nytt.

Den offentlige artikkelsiden **/sak/[slug]** viser bare publiserte artikler, med AI-merking øverst, kildene med
lenke og kildeangivelse, «Slik ble saken laget» (modell, om AI-modereringen faktisk kjørte, og om redaktøren
godkjente) og endringslogg. Siden har maskinlesbar merking: `<meta name="ai-generated" content="true">` i
`<head>` for alle, også verktøy uten JavaScript (taggen står i den statiske layouten, `src/app/sak/[slug]/layout.tsx`,
som React løfter inn i `<head>`), `ai-model` i metadata, og strukturerte data (schema.org `NewsArticle` med `creator`
som programvare og `isBasedOn` med kildene). Forsiden har samme meta-tagg. Tittel og beskrivelse strømmes som
vanlig i Next.js, og står i `<head>` for roboter som ikke kjører JavaScript. En sak uten publisert artikkel gir
siden «fant ikke» med `noindex`.

Kontrollene er testet på syntetiske artikler (`tests/fixtures/generated-articles.json`): for tre saker i korpuset
én god artikkel og fem varianter med hver sin innplantede feil (oppdiktet tall, for langt sitat, oppdiktet sitat,
kopiert setning, navngitt privatperson). De gode artiklene gir ingen funn, og alle 15 feilene fanges og hindrer
automatisk publisering (`npm run eval:generate`). I tillegg testes hver kontroll for seg, også sitatstrek, sitater
over flere avsnitt, utelatelser, nær-kopier, tallord, datoer og klokkeslett. Hvor godt Claude skriver og modererer,
testes med `npm run eval:generate -- --claude` (krever nøkkel, seks kall).

**Kjente begrensninger i kontrollene.** Tallkontrollen ser bare om et tall står et sted i kildene, ikke om det
brukes om det samme. Kopikontrollen fanger ikke en tett oversettelse av en kilde på et annet språk; der er
modereringen eneste vern. Et oppdiktet sitat på færre enn fire ord flagges, men stopper ikke publisering (korte
uttrykk i anførselstegn kan være navn eller begreper med en annen bøyning), og et sitat som ikke står ordrett i en
kilde, stopper ikke publisering når noen av kildene er på et annet språk (det kan være oversatt); redaktøren
vurderer. At en navngitt person er privatperson, avgjøres av skriveren og modereringen. Kontrollen ser i tillegg
etter navn som ikke står i personlisten, men det er en enkel regel (to ord med stor forbokstav på rad) som både kan
bomme og gi falske funn.

### Mappestruktur

```
config/site.config.ts      Juridisk og redaksjonell konfigurasjon (én fil)
prisma/schema.prisma       Datamodell
prisma/migrations/         SQL-migreringer
prisma/seed.ts             Synkroniserer kildene fra konfigurasjonen til databasen
scripts/ingest.ts          Kjører innhenting og sletting (npm run ingest)
scripts/purge-expired.ts   Sletter kildetekst som har passert sletteperioden
scripts/eval-clustering.ts Måler grupperingen på testkorpuset (npm run eval:cluster)
scripts/eval-generation.ts Kjører kontrollene på testartiklene, og med --claude ekte skriving (npm run eval:generate)
prompts/                   Promptene til Claude, én fil per oppgave
src/app/                   Sider og API-ruter (forside, /sak/[slug], /admin, /api/cron/ingest, /api/health)
src/lib/ingest/            Innhenting: HTTP, robots.txt/TDM, feed-parser, adaptere, jobben
src/lib/cluster/           Gruppering: tekstanalyse, plassering, Claude i gråsonen, jobben, manuell flytting
src/lib/generate/          Skriving: kildeforberedelse, Claude-skriver og -moderator, kontroller, vurdering, jobben, godkjenning
src/lib/ai/                Claude-klient, strukturerte kall og lasting av prompter
src/lib/markdown.ts        Trygg tolkning av brødteksten (avsnitt, mellomtitler, lister)
src/lib/config/            zod-skjema og validert konfigurasjon
src/lib/retention.ts       Sletteregler for kildetekst og jobblogg
src/lib/sources/sync.ts    Synkronisering av kilder
src/lib/auth/              Basic Auth for admin (proxy og datalag)
src/proxy.ts               Beskytter /admin og /api/admin
tests/                     Vitest-tester
```

### Datamodell

| Modell             | Rolle                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `Source`           | En kilde med lisens, vilkår og status. Konfigurasjonen er fasit.                            |
| `SourceItem`       | Én hentet artikkel. Teksten slettes etter sletteperioden, men tittel og URL beholdes. Lagrer også hvordan elementet ble gruppert (metode, likhet, Claudes begrunnelse). |
| `Story`            | En sak som samler kildeartikler, med kategori, sensitivitet og forsøk på å skrive artikkel. Kan ikke slettes så lenge den har en artikkel. |
| `Article`          | Gjeldende versjon av artikkelen: status, versjon, «Rettet»-merking og AI-merking.           |
| `ArticleRevision`  | Endringsloggen. Hver versjon er et fullt øyeblikksbilde med hva som endret seg og hvorfor. |
| `RevisionSource`   | Hvilke kildeartikler hver versjon bygger på.                                               |
| `ModerationReview` | Kontrollen av en versjon: alle funn, vurdering, og hvem som godkjente eller avviste.      |
| `JobRun`           | Logg over kjøringer av innhenting, gruppering, generering og sletting.                     |

Det finnes bevisst ingen tabell for chatter. Chatter lagres ikke som standard.

## Kilder

Kildene er valgt fordi lisensen tillater gjenbruk. Lisensene er foreløpig bare sjekket via websøk, så alle står som
«Må verifiseres». En kilde kan bare aktiveres når et menneske har lest vilkårene, lisensen er åpen og det ikke er
funnet noen reservasjon mot tekst- og datautvinning. Det håndheves av skjemaet i `src/lib/config/schema.ts`.

| Kilde                         | Lisens               | Merknad                                             |
| ----------------------------- | -------------------- | --------------------------------------------------- |
| Stortinget (data.stortinget.no) | NLOD               | Åpent API. Krever kildeangivelse.                  |
| SSB                           | CC BY 4.0            | Bilder er ikke omfattet.                            |
| MET Norge – farevarsler       | NLOD 2.0 / CC BY 4.0 | Krever identifiserende User-Agent.                  |
| EU-kommisjonen                | CC BY 4.0            | Offisiell RSS-feed er ikke funnet.                  |
| Regjeringen.no                | Ukjent               | Ingen uttrykkelig lisens funnet for tekstene.       |

NRK og kommersielle mediehus er valgt bort fordi vilkårene deres ikke tillater denne typen gjenbruk.

## Kommandoer

| Kommando             | Hva den gjør                                                         |
| -------------------- | -------------------------------------------------------------------- |
| `npm run dev`        | Utviklingsserver                                                     |
| `npm run build`      | Produksjonsbygg                                                      |
| `npm run check`      | Lint, typesjekk, tester og sjekk av at migreringene matcher skjemaet |
| `npm test`           | Tester                                                               |
| `npm run db:migrate` | Ny migrering etter endring i `prisma/schema.prisma`                  |
| `npm run ingest`     | Synkroniserer kildene, henter fra aktive kilder, grupperer, skriver artikler og sletter gammel tekst |
| `npm run eval:cluster` | Måler grupperingen på testkorpuset. Med `-- --claude` brukes Claude i gråsonen |
| `npm run eval:generate` | Kjører kontrollene på testartiklene. Med `-- --claude` skriver og modererer Claude |
| `npm run db:seed`    | Synkroniserer kildene fra konfigurasjonen                            |
| `npm run db:reset`   | Nullstiller databasen, kjører migreringene og synkroniserer kildene  |
| `npm run purge`      | Sletter kildetekst som har passert sletteperioden                    |

## Tester

Testene bruker en egen, midlertidig SQLite-database per testfil, med migreringene fra `prisma/migrations`. De går
aldri mot nettet: innhentingen testes med en falsk `fetch` og syntetiske eksempelfeeder i `tests/fixtures/`. Claude kalles aldri: `ANTHROPIC_API_KEY` tømmes i `vitest.config.ts`, og Claude-delen testes med en falsk klient. De dekker:

- at konfigurasjonen er gyldig, og at skjemaet stopper ulovlige oppsett (aktiv kilde uten åpen lisens eller leste
  vilkår, TDM-reservasjon, lagring av IP-adresser, navngiving av privatpersoner, visning av kildenes bilder)
- sletting av kildetekst, inkludert at tittel og URL beholdes og at en kortere sletteperiode også gjelder lagret tekst
- synkronisering av kilder fra konfigurasjonen
- innhenting: RSS 2.0, RSS 1.0, Atom og Stortinget-adapteren, robots.txt og TDM-reservasjoner (fil, header, meta og
  KI-crawlere, også for enkeltartikler og ved omdirigeringer), at ingenting hentes når reglene ikke kan leses,
  størrelsesgrense, tegnsett, tidsavbrudd, betingede forespørsler, minste intervall, duplikater og endringer,
  fulltekst bare fra kildens egne verter, feil i én kilde som ikke stopper de andre, og samtidige kjøringer
- gruppering: ordstammer, stoppord, ledetekster, TF-IDF og cosinus, grensene, gråsonen og regelen for samme kilde,
  tidsvinduet og maks varighet, elementer i feil rekkefølge, hva Claude får se (bare tittel og kort utdrag, de fire
  nyeste elementene, uten mulighet til å lage egne tagger), og kvaliteten på begge korpusene (ingen feil
  sammenslåinger, de vanskelige parene holdes adskilt)
- Claude-kallet med en ekte SDK-klient og falskt nettverkslag: modell, beta-header, reservemodell, JSON-skjema med
  enum, avslag, avkortede og ugyldige svar (tokenene telles likevel), og at feil nøkkel stopper videre kall
- grupperingsjobben mot en ekte database: nye saker og saker fra tidligere kjøringer, at tekst som ikke kan
  analyseres (reservert, slettet, pauset kilde, kilde med TDM-reservasjon) verken grupperes, sendes til Claude eller
  påvirker ordvektene, lagring av metode, likhet og begrunnelse, endringer fra andre prosesser underveis, slugs som
  er brukt opp, og at feil i oppsettet av Claude ikke stopper jobben
- manuell flytting i admin: skill ut, flytt, angre, ny arbeidstittel, ikke for saker med artikkel og ikke mens
  grupperingen kjører, og at feilmeldinger bare vises fra en fast liste med koder
- skriving og moderering: kontrollene på de syntetiske artiklene (alle innplantede feil fanges og hindrer automatisk
  publisering, de gode gir ingen funn) og hver kontroll for seg med grensene (sitatlengde, korte sitater,
  sitattegn, sitatstrek, sitater over flere avsnitt, utelatelser og innskudd, samlet sitatmengde, oversatte
  sitater, kopiert og nesten kopiert tekst, navn og titler, tall, tallord, datoer, klokkeslett, privatpersoner,
  personpåstander, navn i genitiv og institusjonsnavn, navn utenfor personlisten, kildenøkler, lenker, HTML og
  lengde; hver normalisering av tall testes mot en kilde der bare den ene formen står, også rundt skifte til
  vintertid), den samlede vurderingen, kildene Claude får
  (rekkefølge, budsjett, språk, avkorting, norsk tid, uten mulighet til å lage tagger), skriver- og moderatorkallet
  med ekte SDK-klient (prompt med innstillingene, tidspunkt, skjema med enum, avslag, ugyldige svar, svar fra
  reservemodellen, tidsgrense og nye forsøk, tokens fra alle forsøk, hvilke feil fra API-et som stopper kjøringen og
  hvilke som telles mot saken), og jobben mot en ekte database (hvilke saker som er klare og i hvilken rekkefølge,
  lagring av artikkel, versjon, kilder og moderering, automatisk publisering, feil som telles og feil som stopper
  kjøringen, tidsfristen, tekst som utløper underveis, kilder som flyttes eller saker som slettes underveis, og
  samtidige jobber og prosesser)
- godkjenning: publisering, avvisning, ny skriving (ikke for saker som ikke ville blitt skrevet igjen), «Prøv igjen»
  og avpublisering med endringslogg, sidevisning av publiserte og avviste artikler (også sidetall som er for høye, og
  at sidetallene beholdes etter en handling), at artikler som bryter faste
  regler ikke kan publiseres, og at bare publiserte artikler vises for lesere
- artikkelsiden: synlig og maskinlesbar AI-merking (også at meta-taggen står i den statiske layouten), strukturerte
  data, kildene med kreditering uten kildetekst, og
  teksten om hvordan saken ble kontrollert, også når AI-modereringen ikke kunne kjøre
- brødteksten: avsnitt, mellomtitler, punktlister og nummererte lister (også uten tom linje imellom, og med
  fortsettelseslinjer), nivå på mellomtitlene, og at HTML
  vises som tekst
- hele pipelinen mot en ekte database: synkronisering, innhenting, sletting av utløpt tekst (før grupperingen og
  skrivingen), gruppering, skriving og oppsummeringen, at slettingen kjører selv om et steg feiler, og at en feil i
  skrivingen meldes
- knappene i admin: «Kjør innhenting nå», «Skill ut», «Flytt», «Marker som avbrutt», «Godkjenn og publiser», «Avvis»,
  «Skriv på nytt», «Prøv igjen» og «Avpubliser» (tilgangssjekk i server actions, validering og meldinger bare fra
  faste koder)
- manuell flytting med utkast: utkastet slettes når kildene flyttes eller et element skilles ut, også når saken blir
  tom, og ingenting flyttes hvis artikkelen blir publisert mellom kontrollen og flyttingen
- cron-ruten og Bearer-tokenet, også at en feilet eller stoppet skriving gir 500
- tilgangskontroll for admin: hvilke ruter proxyen dekker, svarene den gir, at admin ikke kan rammes inn av andre
  nettsteder, krav til passord og at datalaget avviser forespørsler uten gyldig innlogging før databasen leses
- datamodellen fra kilde til endringslogg, med fremmednøkler og unike nøkler, og at en sak med artikkel ikke kan
  slettes
