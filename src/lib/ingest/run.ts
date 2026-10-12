import type { Prisma } from "@/generated/prisma/client";
import type { SiteConfig, SourceConfig } from "../config/schema";
import type { Db } from "../db";
import { computeDeleteAfter, DAY_MS, failStaleJobRuns, STALE_JOB_MS } from "../retention";
import { checkAccess, loadHostPolicy, tdmReservedByHeaderOrMeta, type HostPolicy } from "./access";
import { ADAPTERS } from "./adapters";
import type { FeedItem } from "./feed";
import { politeFetch, type FetchLike, type HttpOptions } from "./http";
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

/**
 * Henter nye elementer fra alle aktive kilder og lagrer dem.
 *
 * Bare kilder som er ACTIVE i config/site.config.ts hentes. For hver kilde
 * sjekkes robots.txt og TDM-reservasjoner først, og bare tekst lagres (aldri
 * bilder eller HTML), avkortet etter konfigurasjonen og med slettedato.
 */
export async function runIngestJob(db: Db, options: IngestOptions): Promise<IngestResult> {
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
      fullTextFetched: 0,
    };
    const row = await this.db.source.findUnique({ where: { slug: source.slug } });
    if (!row || row.status !== "ACTIVE" || !source.feedUrl) {
      return { ...result, outcome: "skipped", reason: "Kilden er ikke aktiv i databasen. Kjør npm run db:seed." };
    }

    const { ingestion } = this.options.config;
    const minInterval = ingestion.minIntervalMinutes * 60_000;
    if (row.lastAttemptAt && this.now.getTime() - row.lastAttemptAt.getTime() < minInterval) {
      return {
        ...result,
        outcome: "skipped",
        reason: `Hentet for under ${ingestion.minIntervalMinutes} minutter siden`,
      };
    }
    await this.db.source.update({ where: { id: row.id }, data: { lastAttemptAt: this.now } });

    try {
      const feedUrl = new URL(source.feedUrl);
      const policy = await this.policyFor(feedUrl.origin);
      const access = checkAccess(policy, feedUrl.toString(), ingestion);
      await this.db.source.update({
        where: { id: row.id },
        data: {
          robotsCheckedAt: this.now,
          robotsAllowed: !(access.ok === false && access.kind === "robots"),
          tdmCheckedAt: this.now,
          tdmReservationFound: access.ok === false && access.kind === "tdm",
        },
      });
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
      });

      if (response.status === 304) {
        await this.succeed(row.id, row.etag, row.lastModified);
        return { ...result, outcome: "not-modified" };
      }
      if (response.status < 200 || response.status >= 300) {
        const reason = `Feeden svarte HTTP ${response.status}`;
        await this.fail(row.id, reason);
        return { ...result, outcome: "failed", reason };
      }
      if (tdmReservedByHeaderOrMeta(response.headers)) {
        const reason = "Feeden har «tdm-reservation: 1» i HTTP-headeren";
        await this.db.source.update({ where: { id: row.id }, data: { tdmReservationFound: true } });
        await this.fail(row.id, reason);
        return { ...result, outcome: "blocked", reason };
      }

      const cutoff = this.now.getTime() - ingestion.maxItemAgeDays * DAY_MS;
      const items = adapter
        .parse(response.body, response.url)
        .filter((item) => {
          const tooOld = item.publishedAt !== null && item.publishedAt.getTime() < cutoff;
          if (tooOld) result.tooOld++;
          return !tooOld;
        })
        .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
        .slice(0, ingestion.maxItemsPerSource);

      for (const item of items) {
        const outcome = await this.storeItem(row.id, source, item);
        result[outcome.status]++;
        if (outcome.fullText) result.fullTextFetched++;
      }

      await this.succeed(row.id, response.headers.get("etag"), response.headers.get("last-modified"));
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.fail(row.id, reason);
      return { ...result, outcome: "failed", reason };
    }
  }

  /** Lagrer et nytt eller endret element. Uendrede elementer røres ikke, så slettefristen ikke forlenges. */
  private async storeItem(
    sourceId: string,
    source: SourceConfig,
    item: FeedItem,
  ): Promise<{ status: "created" | "updated" | "unchanged"; fullText: boolean }> {
    const { ingestion, retention } = this.options.config;
    const excerpt = item.summary ? truncate(item.summary, ingestion.maxExcerptChars) : null;
    const feedText = item.content ? truncate(item.content, ingestion.maxTextChars) : null;
    const hash = contentHash(item.title, item.url, excerpt, feedText);

    const existing = await this.db.sourceItem.findUnique({
      where: { sourceId_guid: { sourceId, guid: item.guid } },
      select: { id: true, contentHash: true },
    });
    if (existing?.contentHash === hash) {
      return { status: "unchanged", fullText: false };
    }

    let bodyText = feedText;
    let fullText = false;
    if (!bodyText && source.allowFullTextFetch) {
      bodyText = await this.fetchFullText(source, item.url);
      fullText = bodyText !== null;
    }

    const data = {
      url: item.url,
      title: truncate(item.title, 500),
      publishedAt: item.publishedAt,
      excerpt,
      bodyText,
      contentHash: hash,
      language: source.language,
      fetchedAt: this.now,
      deleteAfter: computeDeleteAfter(this.now, retention.sourceTextDays),
      purgedAt: null,
    };
    if (existing) {
      await this.db.sourceItem.update({ where: { id: existing.id }, data });
      return { status: "updated", fullText };
    }
    await this.db.sourceItem.create({ data: { sourceId, guid: item.guid, ...data } });
    return { status: "created", fullText };
  }

  /**
   * Henter hovedteksten fra artikkelsiden. Bare for kilder med åpen lisens og
   * `allowFullTextFetch`, bare på kildens egne verter, og bare når robots.txt
   * og TDM-reglene tillater det.
   */
  private async fetchFullText(source: SourceConfig, url: string): Promise<string | null> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return null;
    }
    const ownHosts = new Set([new URL(source.homepageUrl).host, new URL(source.feedUrl!).host]);
    if (target.protocol !== "https:" || !ownHosts.has(target.host)) {
      return null;
    }
    const { ingestion } = this.options.config;
    const policy = await this.policyFor(target.origin);
    if (!checkAccess(policy, target.toString(), ingestion).ok) {
      return null;
    }
    try {
      const page = await politeFetch(target.toString(), { ...this.http, headers: { Accept: "text/html" } });
      if (page.status !== 200 || tdmReservedByHeaderOrMeta(page.headers, page.body)) {
        return null;
      }
      const text = extractArticleText(page.body, page.url);
      return text ? truncate(text, ingestion.maxTextChars) : null;
    } catch {
      return null;
    }
  }

  /** robots.txt og tdmrep.json hentes én gang per vert per kjøring. */
  private policyFor(origin: string): Promise<HostPolicy> {
    let policy = this.policies.get(origin);
    if (!policy) {
      policy = loadHostPolicy(origin, this.http);
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
