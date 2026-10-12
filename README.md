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
| 3    | Gruppering av kildeartikler til saker         | Planlagt  |
| 4    | Artikkelgenerering med moderasjonssteg        | Planlagt  |
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
- **Claude API** (`claude-sonnet-5-5`) via Anthropics offisielle TypeScript-SDK, fra fase 4

## Kom i gang

Krever Node.js 22 eller nyere.

```bash
cp .env.example .env       # sett ADMIN_TOKEN for å bruke /admin, f.eks. med: openssl rand -base64 32
npm install                # genererer også Prisma-klienten
npm run db:deploy          # lager prisma/dev.db og kjører migreringene
npm run db:seed            # synkroniserer kildene fra config/site.config.ts
npm run dev                # http://localhost:3000
```

Kjør innhentingen med `npm run ingest`, med knappen «Kjør innhenting nå» i admin, eller fra en cron-jobb:

```bash
# CRON_SECRET settes i .env (tilfeldig, minst 24 tegn)
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
                      robots.txt,                 (fase 3)        │
                      TDM-sjekk                                   ▼
                                               Generering ─► Moderasjon ─► Article (+ ArticleRevision)
                                               (fase 4)      AI-kontroll   publisert eller til
                                                             mot kildene   manuell godkjenning
                                                                          │
                       Slettejobb: fjerner kildetekst etter N dager      ▼
                       (tittel og URL beholdes for kildelisten)     Artikkelside + chat (fase 6)
```

### Innhenting (fase 2)

`npm run ingest`, cron-ruten og admin-knappen kjører samme jobb (`src/lib/ingest/pipeline.ts`):

1. **Synkroniser kildene** fra `config/site.config.ts` til databasen.
2. **Hent fra hver aktiv kilde.** Bare kilder med status `ACTIVE` hentes, og skjemaet krever åpen lisens og leste
   vilkår for det. For hver kilde:
   - **robots.txt** leses etter RFC 9309. Kan den ikke leses (5xx eller nettverksfeil), hentes ingenting.
   - **Reservasjon mot tekst- og datautvinning** sjekkes på tre måter: `/.well-known/tdmrep.json` (TDMRep),
     headeren `tdm-reservation: 1`, og om robots.txt sperrer kjente KI-crawlere (`aiCrawlerTokens`). Ved
     reservasjon hoppes kilden over, og funnet vises i admin.
   - **Feeden hentes høflig**: identifiserende User-Agent med kontaktadresse, betingede forespørsler
     (`If-None-Match` / `If-Modified-Since`), minste intervall mellom hentinger, tidsavbrudd, maks størrelse og
     omdirigeringer bare innenfor samme vert.
   - **Feeden leses** som RSS 2.0, RSS 1.0 eller Atom, eller med en egen adapter for Stortingets API. HTML gjøres om
     til ren tekst, og bilder og skript fjernes.
   - **Lagring**: nye elementer får slettedato. Uendrede elementer røres ikke, så slettefristen ikke forlenges.
     Endret innhold lagres på nytt. Elementer eldre enn `maxItemAgeDays` hentes ikke, og teksten kuttes etter
     `maxExcerptChars` og `maxTextChars`.
   - **Fulltekst** hentes bare for kilder med `allowFullTextFetch` (krever åpen lisens), bare fra kildens egne verter,
     og bare når robots.txt og TDM-reglene tillater det. Hovedteksten hentes ut med Mozillas Readability.
3. **Slett utløpt kildetekst** og gamle jobblogger.

Hver kjøring logges som en `JobRun` med resultat per kilde, og to kjøringer kan ikke gå samtidig.

### Mappestruktur

```
config/site.config.ts      Juridisk og redaksjonell konfigurasjon (én fil)
prisma/schema.prisma       Datamodell
prisma/migrations/         SQL-migreringer
prisma/seed.ts             Synkroniserer kildene fra konfigurasjonen til databasen
scripts/ingest.ts          Kjører innhenting og sletting (npm run ingest)
scripts/purge-expired.ts   Sletter kildetekst som har passert sletteperioden
src/app/                   Sider og API-ruter (forside, /admin, /api/cron/ingest, /api/health)
src/lib/ingest/            Innhenting: HTTP, robots.txt/TDM, feed-parser, adaptere, jobben
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
| `SourceItem`       | Én hentet artikkel. Teksten slettes etter sletteperioden, men tittel og URL beholdes.       |
| `Story`            | En sak som samler kildeartikler. Kan ikke slettes så lenge den har en artikkel.            |
| `Article`          | Gjeldende versjon av artikkelen: status, versjon, «Rettet»-merking og AI-merking.           |
| `ArticleRevision`  | Endringsloggen. Hver versjon er et fullt øyeblikksbilde med hva som endret seg og hvorfor. |
| `RevisionSource`   | Hvilke kildeartikler hver versjon bygger på.                                               |
| `ModerationReview` | AI-kontroll av en versjon mot kildene, og eventuell manuell godkjenning.                  |
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
| `npm run ingest`     | Synkroniserer kildene, henter fra aktive kilder og sletter gammel tekst |
| `npm run db:seed`    | Synkroniserer kildene fra konfigurasjonen                            |
| `npm run db:reset`   | Nullstiller databasen, kjører migreringene og synkroniserer kildene  |
| `npm run purge`      | Sletter kildetekst som har passert sletteperioden                    |

## Tester

Testene bruker en egen, midlertidig SQLite-database per testfil, med migreringene fra `prisma/migrations`. De går
aldri mot nettet: innhentingen testes med en falsk `fetch` og syntetiske eksempelfeeder i `tests/fixtures/`. De dekker:

- at konfigurasjonen er gyldig, og at skjemaet stopper ulovlige oppsett (aktiv kilde uten åpen lisens eller leste
  vilkår, TDM-reservasjon, lagring av IP-adresser, navngiving av privatpersoner, visning av kildenes bilder)
- sletting av kildetekst, inkludert at tittel og URL beholdes og at en kortere sletteperiode også gjelder lagret tekst
- synkronisering av kilder fra konfigurasjonen
- innhenting: RSS 2.0, RSS 1.0, Atom og Stortinget-adapteren, robots.txt og TDM-reservasjoner (fil, header, meta og
  KI-crawlere), omdirigeringer, størrelsesgrense, tegnsett, tidsavbrudd, betingede forespørsler, minste intervall,
  duplikater og endringer, fulltekst bare fra kildens egne verter, og lås mot samtidige kjøringer
- cron-ruten og Bearer-tokenet
- tilgangskontroll for admin: hvilke ruter proxyen dekker, svarene den gir, krav til passord og at datalaget
  avviser forespørsler uten gyldig innlogging før databasen leses
- datamodellen fra kilde til endringslogg, med fremmednøkler og unike nøkler, og at en sak med artikkel ikke kan
  slettes
