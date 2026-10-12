import type { Prisma } from "@/generated/prisma/client";
import type { SiteConfig, SourceConfig } from "../config/schema";
import type { Db } from "../db";
import { computeDeleteAfter, DAY_MS, failStaleJobRuns, STALE_JOB_MS } from "../retention";
import { checkAccess, evaluateAccess, loadHostPolicy, tdmReservedByHeaderOrMeta, type HostPolicy } from "./access";
import { ADAPTERS } from "./adapters";
import type { FeedItem } from "./feed";
import { AccessDeniedError, politeFetch, type FetchLike, type HttpOptions } from "./http";
import { contentHash, extractArticleText, truncate } from "./text";

export type SourceOutcome = "fetched" | "not-modified" | "skipped" | "blocked" | "failed";

export type SourceRunResult = {
  slug: string;
  outcome: SourceOutcome;
  reason?: string;
  created: number;
  updated: number;
  unchanged: number;
  tooOld: number;
  /** Elementer kilden har reservert mot tekst- og datautvinning. Bare tittel og lenke er lagret. */
  reserved: number;
  fullTextFetched: number;
};

export type IngestResult =
  | { status: "skipped"; reason: string }
  | { status: "done"; jobId: string; sources: SourceRunResult[] };

export type IngestOptions = {
  config: SiteConfig;
  trigger: string;
  now?: Date;
  fetchImpl?: FetchLike;
};

// Delt på tvers av modulinstanser i samme prosess (route handlers og server
// actions kan ligge i hver sin bunt), så cron og admin-knappen ikke kjører samtidig.
const processLock = globalThis as unknown as { __aiNyheterIngestRunning?: boolean };

/**
 * Henter nye elementer fra alle aktive kilder og lagrer dem.
 *
 * Bare kilder som er ACTIVE i config/site.config.ts hentes. For hver kilde
 * sjekkes robots.txt og TDM-reservasjoner først, også ved omdirigeringer, og
 * bare tekst lagres (aldri bilder eller HTML), avkortet etter konfigurasjonen
 * og med slettedato.
 *
 * To kjøringer i samme prosess kan ikke gå samtidig. På tvers av prosesser
 * (f.eks. `npm run ingest` mens serveren kjører) reserveres hver kilde
 * atomisk i databasen, så samme kilde aldri hentes to ganger innenfor
 * minste intervall.
 */
export async function runIngestJob(db: Db, options: IngestOptions): Promise<IngestResult> {
  if (processLock.__aiNyheterIngestRunning) {
    return { status: "skipped", reason: "En innhenting kjører allerede" };
  }
  processLock.__aiNyheterIngestRunning = true;
  try {
    return await runLocked(db, options);
  } finally {
    processLock.__aiNyheterIngestRunning = false;
  }
}

async function runLocked(db: Db, options: IngestOptions): Promise<IngestResult> {
  const now = options.now ?? new Date();
  await failStaleJobRuns(db, now);

  const running = await db.jobRun.findFirst({
    where: { type: "INGEST", status: "RUNNING", startedAt: { gte: new Date(now.getTime() - STALE_JOB_MS) } },
  });
  if (running) {
    return { status: "skipped", reason: "En innhenting kjører allerede" };
  }

  const job = await db.jobRun.create({ data: { type: "INGEST", trigger: options.trigger, startedAt: now } });
  try {
    const context = new IngestContext(db, options, now);
    const sources: SourceRunResult[] = [];
    for (const source of options.config.sources) {
      if (source.status === "ACTIVE") {
        sources.push(await context.ingestSource(source));
      }
    }
    await db.jobRun.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        stats: { sources, totals: totals(sources) } as unknown as Prisma.InputJsonValue,
      },
    });
    return { status: "done", jobId: job.id, sources };
  } catch (error) {
    await db.jobRun.update({
      where: { id: job.id },
      data: { status: "FAILED", finishedAt: new Date(), error: String(error) },
    });
    throw error;
  }
}

export function totals(sources: SourceRunResult[]) {
  return sources.reduce(
    (sum, s) => ({
      created: sum.created + s.created,
      updated: sum.updated + s.updated,
      failed: sum.failed + (s.outcome === "failed" ? 1 : 0),
      blocked: sum.blocked + (s.outcome === "blocked" ? 1 : 0),
    }),
    { created: 0, updated: 0, failed: 0, blocked: 0 },
  );
}

/**
 * Reserverer en kilde for henting i én atomisk operasjon. Returnerer false
 * hvis kilden ble forsøkt hentet for nylig (også av en annen prosess).
 */
export async function claimSource(db: Db, sourceId: string, now: Date, minIntervalMs: number): Promise<boolean> {
  const { count } = await db.source.updateMany({
    where: {
      id: sourceId,
      status: "ACTIVE",
      OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: new Date(now.getTime() - minIntervalMs) } }],
    },
    data: { lastAttemptAt: now },
  });
  return count === 1;
}

type StoreOutcome = { status: "created" | "updated" | "unchanged"; fullText: boolean; reserved: boolean };

class IngestContext {
  private readonly policies = new Map<string, Promise<HostPolicy>>();
  private readonly http: HttpOptions;

  constructor(
    private readonly db: Db,
    private readonly options: IngestOptions,
    private readonly now: Date,
  ) {
    const { ingestion } = options.config;
    this.http = {
      userAgent: ingestion.userAgent,
      timeoutMs: ingestion.requestTimeoutMs,
      maxBytes: ingestion.maxResponseBytes,
      fetchImpl: options.fetchImpl,
    };
  }

  async ingestSource(source: SourceConfig): Promise<SourceRunResult> {
    const result: SourceRunResult = {
      slug: source.slug,
      outcome: "fetched",
      created: 0,
      updated: 0,
      unchanged: 0,
      tooOld: 0,
      reserved: 0,
      fullTextFetched: 0,
    };
    const row = await this.db.source.findUnique({ where: { slug: source.slug } });
    if (!row || row.status !== "ACTIVE" || !source.feedUrl) {
      return { ...result, outcome: "skipped", reason: "Kilden er ikke aktiv i databasen. Kjør npm run db:seed." };
    }

    const { ingestion } = this.options.config;
    if (!(await claimSource(this.db, row.id, this.now, ingestion.minIntervalMinutes * 60_000))) {
      return {
        ...result,
        outcome: "skipped",
        reason: `Hentet for under ${ingestion.minIntervalMinutes} minutter siden`,
      };
    }

    try {
      const feedUrl = new URL(source.feedUrl);
      const policy = await this.policyFor(feedUrl.origin);
      const report = evaluateAccess(policy, feedUrl.toString(), ingestion);
      await this.db.source.update({
        where: { id: row.id },
        data: {
          robotsCheckedAt: this.now,
          robotsAllowed: report.robots.ok,
          // TDM-feltene endres bare når TDM faktisk ble vurdert. null betyr «ukjent».
          ...(report.tdm && {
            tdmCheckedAt: this.now,
            tdmReservationFound: report.tdm.ok ? false : report.tdm.unknown ? null : true,
          }),
        },
      });
      const access = report.robots.ok && report.tdm ? report.tdm : report.robots;
      if (!access.ok) {
        await this.fail(row.id, access.reason);
        return { ...result, outcome: "blocked", reason: access.reason };
      }

      const adapter = ADAPTERS[source.adapter];
      const conditional: Record<string, string> = {};
      if (row.etag) conditional["If-None-Match"] = row.etag;
      if (row.lastModified) conditional["If-Modified-Since"] = row.lastModified;
      const response = await politeFetch(feedUrl.toString(), {
        ...this.http,
        headers: { Accept: adapter.accept, ...conditional },
        checkUrl: this.guard(policy),
      });

      if (tdmReservedByHeaderOrMeta(response.headers)) {
        const reason = "Feeden har «tdm-reservation: 1» i HTTP-headeren";
        // Fjerner validatorene, så neste henting ikke får 304 og overser reservasjonen.
        await this.db.source.update({
          where: { id: row.id },
          data: { tdmReservationFound: true, tdmCheckedAt: this.now, etag: null, lastModified: null },
        });
        await this.fail(row.id, reason);
        return { ...result, outcome: "blocked", reason };
      }
      if (response.status === 304) {
        await this.succeed(row.id, row.etag, row.lastModified);
        return { ...result, outcome: "not-modified" };
      }
      if (response.status < 200 || response.status >= 300) {
        const reason = `Feeden svarte HTTP ${response.status}`;
        await this.fail(row.id, reason);
        return { ...result, outcome: "failed", reason };
      }

      const cutoff = this.now.getTime() - ingestion.maxItemAgeDays * DAY_MS;
      const seen = new Set<string>();
      const items = adapter
        .parse(response.body, response.url)
        .filter((item) => {
          const tooOld = item.publishedAt !== null && item.publishedAt.getTime() < cutoff;
          if (tooOld) result.tooOld++;
          return !tooOld;
        })
        .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
        // Samme guid to ganger i én feed: behold den nyeste, ellers overskriver de hverandre.
        .filter((item) => !seen.has(item.guid) && Boolean(seen.add(item.guid)))
        .slice(0, ingestion.maxItemsPerSource);

      for (const item of items) {
        const outcome = await this.storeItem(row.id, source, item);
        result[outcome.status]++;
        if (outcome.fullText) result.fullTextFetched++;
        if (outcome.reserved && outcome.status !== "unchanged") result.reserved++;
      }

      await this.succeed(row.id, response.headers.get("etag"), response.headers.get("last-modified"));
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.fail(row.id, reason);
      return { ...result, outcome: error instanceof AccessDeniedError ? "blocked" : "failed", reason };
    }
  }

  /**
   * Lagrer et nytt eller endret element. Uendrede elementer røres ikke, så
   * slettefristen ikke forlenges. Er elementet reservert mot tekst- og
   * datautvinning, lagres bare tittel og lenke.
   */
  private async storeItem(sourceId: string, source: SourceConfig, item: FeedItem): Promise<StoreOutcome> {
    const { ingestion, retention } = this.options.config;
    let reserved = await this.isItemReserved(source, item.url);
    const excerpt = reserved || !item.summary ? null : truncate(item.summary, ingestion.maxExcerptChars);
    const feedText = reserved || !item.content ? null : truncate(item.content, ingestion.maxTextChars);
    const hash = contentHash(item.title, item.url, excerpt, feedText, reserved ? "tdm-reservert" : null);

    const existing = await this.db.sourceItem.findUnique({
      where: { sourceId_guid: { sourceId, guid: item.guid } },
      select: { id: true, contentHash: true },
    });
    if (existing?.contentHash === hash) {
      return { status: "unchanged", fullText: false, reserved };
    }

    let bodyText = feedText;
    let fullText = false;
    if (!reserved && !bodyText && source.allowFullTextFetch) {
      const page = await this.fetchFullText(source, item.url);
      bodyText = page.text;
      fullText = page.text !== null;
      // Reserverer artikkelsiden seg, lagres heller ikke utdraget fra feeden.
      reserved = page.reserved;
    }

    const data = {
      url: item.url,
      title: truncate(item.title, 500),
      publishedAt: item.publishedAt,
      excerpt: reserved ? null : excerpt,
      bodyText: reserved ? null : bodyText,
      tdmReserved: reserved,
      contentHash: hash,
      language: source.language,
      fetchedAt: this.now,
      deleteAfter: computeDeleteAfter(this.now, retention.sourceTextDays),
      purgedAt: null,
    };
    if (existing) {
      await this.db.sourceItem.update({ where: { id: existing.id }, data });
      return { status: "updated", fullText, reserved };
    }
    await this.db.sourceItem.create({ data: { sourceId, guid: item.guid, ...data } });
    return { status: "created", fullText, reserved };
  }

  /**
   * Har kilden reservert akkurat denne artikkelen mot tekst- og datautvinning
   * (tdmrep.json-regler for stien eller sperre for KI-crawlere i robots.txt)?
   * Sjekkes for lenker på kildens egne verter, der reglene uansett er lastet.
   * Kan reglene ikke leses, regnes artikkelen som reservert.
   */
  private async isItemReserved(source: SourceConfig, url: string): Promise<boolean> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return false;
    }
    if (!this.ownHosts(source).has(target.host)) {
      return false;
    }
    target.protocol = "https:";
    const policy = await this.policyFor(target.origin);
    const { robots, tdm } = evaluateAccess(policy, target.toString(), this.options.config.ingestion);
    // Sperrer robots.txt stien, ble TDM ikke vurdert. Vi henter den uansett ikke, men feedteksten er lisensiert.
    return robots.ok && tdm !== null && !tdm.ok;
  }

  /**
   * Henter hovedteksten fra artikkelsiden. Bare for kilder med åpen lisens og
   * `allowFullTextFetch`, bare på kildens egne verter, og bare når robots.txt
   * og TDM-reglene tillater det, også for eventuelle omdirigeringer.
   */
  private async fetchFullText(source: SourceConfig, url: string): Promise<{ text: string | null; reserved: boolean }> {
    const none = { text: null, reserved: false };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return none;
    }
    if (target.protocol !== "https:" || !this.ownHosts(source).has(target.host)) {
      return none;
    }
    const { ingestion } = this.options.config;
    const policy = await this.policyFor(target.origin);
    try {
      // guard() sjekker robots.txt og TDM for adressen og for hver omdirigering før noe hentes.
      const page = await politeFetch(target.toString(), {
        ...this.http,
        headers: { Accept: "text/html" },
        checkUrl: this.guard(policy),
      });
      if (tdmReservedByHeaderOrMeta(page.headers, page.body)) {
        return { text: null, reserved: true };
      }
      if (page.status !== 200) {
        return none;
      }
      const text = extractArticleText(page.body, page.url);
      return { text: text ? truncate(text, ingestion.maxTextChars) : null, reserved: false };
    } catch {
      return none;
    }
  }

  private ownHosts(source: SourceConfig): Set<string> {
    return new Set([new URL(source.homepageUrl).host, new URL(source.feedUrl!).host]);
  }

  /** Stopper forespørsler og omdirigeringer som robots.txt eller TDM-reglene ikke tillater. */
  private guard(policy: HostPolicy) {
    const ingestion = this.options.config.ingestion;
    return (url: URL) => {
      const decision = checkAccess(policy, url.toString(), ingestion);
      return decision.ok ? null : decision.reason;
    };
  }

  /** robots.txt og tdmrep.json hentes én gang per vert per kjøring. */
  private policyFor(origin: string): Promise<HostPolicy> {
    let policy = this.policies.get(origin);
    if (!policy) {
      policy = loadHostPolicy(origin, this.http, { userAgent: this.options.config.ingestion.userAgent });
      this.policies.set(origin, policy);
    }
    return policy;
  }

  private async succeed(sourceId: string, etag: string | null, lastModified: string | null) {
    await this.db.source.update({
      where: { id: sourceId },
      data: { lastFetchedAt: this.now, lastFetchError: null, etag, lastModified },
    });
  }

  private async fail(sourceId: string, reason: string) {
    await this.db.source.update({ where: { id: sourceId }, data: { lastFetchError: reason } });
  }
}
