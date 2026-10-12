# AI-nyheter

En nyhetsside der kunstig intelligens skriver nøytrale saker basert **kun** på åpent lisensierte kilder. Siden henter
nyheter fra RSS og åpne API-er, grupperer kildeartikler som handler om det samme, skriver én artikkel per sak med
lenker til alle kildene, oppdaterer artikkelen med synlig endringslogg når nye kilder kommer, og lar leseren chatte
med AI-en om hver sak. Chatten svarer bare ut fra kildene til den saken.

Prosjektet er laget for å drives etter norsk lov og EØS-regler (opphavsrett, medieansvar, personvern og EUs
AI-forordning). Juridiske hensyn styrer designet, og alle juridisk relevante innstillinger ligger i én fil:
[`config/site.config.ts`](config/site.config.ts). Se [LEGAL.md](LEGAL.md) for tiltakene og begrunnelsen.

> Porteføljeprosjekt. Siden kjøres lokalt og er ikke publisert.

## Status

| Fase | Innhold                                       | Status    |
| ---- | --------------------------------------------- | --------- |
| 1    | Oppsett, datamodell og juridisk konfigurasjon | ✅ Ferdig |
| 2    | Innhenting fra RSS og åpne API-er             | Planlagt  |
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
cp .env.example .env       # sett ADMIN_TOKEN (minst 12 tegn) for å bruke /admin
npm install                # genererer også Prisma-klienten
npm run db:deploy          # lager prisma/dev.db og kjører migreringene
npm run db:seed            # synkroniserer kildene fra config/site.config.ts
npm run dev                # http://localhost:3000
```

Admin ligger på <http://localhost:3000/admin>. Brukernavnet er `admin`, og passordet er `ADMIN_TOKEN` fra `.env`.

## Arkitektur

```
            config/site.config.ts  (kilder, lisenser, sletteperiode, godkjenningskrav)
                       │  valideres med zod ved oppstart
                       ▼
 RSS / åpne API-er ─► Innhenting ─► SourceItem ─► Gruppering ─► Story
   (fase 2)           robots.txt,                 (fase 3)        │
                      lisenssjekk                                 ▼
                                               Generering ─► Moderasjon ─► Article (+ ArticleRevision)
                                               (fase 4)      AI-kontroll   publisert eller til
                                                             mot kildene   manuell godkjenning
                                                                          │
                       Slettejobb: fjerner kildetekst etter N dager      ▼
                       (tittel og URL beholdes for kildelisten)     Artikkelside + chat (fase 6)
```

### Mappestruktur

```
config/site.config.ts      Juridisk og redaksjonell konfigurasjon (én fil)
prisma/schema.prisma       Datamodell
prisma/migrations/         SQL-migreringer
prisma/seed.ts             Synkroniserer kildene fra konfigurasjonen til databasen
scripts/purge-expired.ts   Sletter kildetekst som har passert sletteperioden
src/app/                   Sider og API-ruter (forside, /admin, /api/health)
src/lib/config/            zod-skjema og validert konfigurasjon
src/lib/retention.ts       Sletteregler for kildetekst og jobblogg
src/lib/sources/sync.ts    Synkronisering av kilder
src/lib/auth/              Basic Auth for admin (proxy og serverside)
src/proxy.ts               Beskytter /admin og /api/admin
tests/                     Vitest-tester
```

### Datamodell

| Modell             | Rolle                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `Source`           | En kilde med lisens, vilkår og status. Konfigurasjonen er fasit.                            |
| `SourceItem`       | Én hentet artikkel. Teksten slettes etter sletteperioden, men tittel og URL beholdes.       |
| `Story`            | En sak som samler kildeartikler om det samme, med eventuell sensitivitetsmerking.          |
| `Article`          | Gjeldende versjon av artikkelen: status, versjon, «Rettet»-merking og AI-merking.           |
| `ArticleRevision`  | Endringsloggen. Hver versjon er et fullt øyeblikksbilde med hva som endret seg og hvorfor. |
| `RevisionSource`   | Hvilke kildeartikler hver versjon bygger på.                                               |
| `ModerationReview` | AI-kontroll av en versjon mot kildene, og eventuell manuell godkjenning.                  |
| `JobRun`           | Logg over kjøringer av innhenting, gruppering, generering og sletting.                     |

Det finnes bevisst ingen tabell for chatter. Chatter lagres ikke som standard.

## Kilder

Kildene er valgt fordi lisensen tillater gjenbruk. Alle står foreløpig som «Må verifiseres». En kilde kan bare
aktiveres når vilkårene er lest, lisensen er åpen og det ikke er funnet noen reservasjon mot tekst- og
datautvinning. Det håndheves av skjemaet i `src/lib/config/schema.ts`.

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
| `npm run db:seed`    | Synkroniserer kildene fra konfigurasjonen                            |
| `npm run purge`      | Sletter kildetekst som har passert sletteperioden                    |

## Tester

Testene bruker en egen, midlertidig SQLite-database per testfil, med migreringene fra `prisma/migrations`. De dekker:

- at konfigurasjonen er gyldig, og at skjemaet stopper ulovlige oppsett (aktiv kilde uten åpen lisens eller leste
  vilkår, TDM-reservasjon, lagring av IP-adresser, navngiving av privatpersoner, visning av kildenes bilder)
- sletting av kildetekst, inkludert at tittel og URL beholdes og at en kortere sletteperiode også gjelder lagret tekst
- synkronisering av kilder fra konfigurasjonen
- Basic Auth for admin
- datamodellen fra kilde til endringslogg, med fremmednøkler og unike nøkler
