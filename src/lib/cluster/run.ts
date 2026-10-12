import type { Prisma } from "@/generated/prisma/client";
import { type ClaudeUsage, createClaudeClient } from "../ai/claude";
import type { SiteConfig } from "../config/schema";
import type { Db } from "../db";
import { truncate } from "../ingest/text";
import { DAY_MS, failStaleJobRuns, STALE_JOB_MS } from "../retention";
import { Clusterer, type Member, type Placement, type StoryJudge } from "./assign";
import { type ItemText, TermStats, termFrequencies, type TermVector, weigh } from "./features";
import { createClaudeJudge } from "./judge";
import { slugify, uniqueSlug } from "./slug";

export type ClusterStats = {
  /** Elementer som ble gruppert i denne kjøringen. */
  considered: number;
  newStories: number;
  /** Lagt til en eksisterende sak fordi likheten var over grensen. */
  joined: number;
  /** Lagt til en eksisterende sak etter vurdering fra Claude. */
  joinedByClaude: number;
  /** Ny sak etter vurdering fra Claude. */
  newByClaude: number;
  /**
   * Nye saker der likheten var i gråsonen uten at Claude avgjorde (Claude er
   * ikke satt opp, grensen for antall kall er nådd, eller kallet feilet).
   * Disse bør en redaktør se på.
   */
  uncertain: number;
  /** Elementer en annen prosess rakk å gruppere først. */
  skipped: number;
  claude: ClaudeUsage | null;
  promptVersion: string | null;
};

export type ClusterResult =
  | { status: "skipped"; reason: string }
  | { status: "done"; jobId: string; stats: ClusterStats };

export type JudgeSetup = { judge: StoryJudge; usage: ClaudeUsage; promptVersion?: string };

export type ClusterOptions = {
  config: SiteConfig;
  trigger: string;
  now?: Date;
  /**
   * Hvem som avgjør elementer i gråsonen. Utelatt: Claude hvis det er slått på
   * i konfigurasjonen og ANTHROPIC_API_KEY er satt. null: ingen (gråsonen blir
   * nye saker).
   */
  judge?: JudgeSetup | null;
};

/** Så mange av de nyeste elementene brukes til å vekte ord. */
const MAX_REFERENCE_ITEMS = 5000;

const processLock = globalThis as unknown as { __aiNyheterClusterRunning?: boolean };

/**
 * Grupperer nye kildeelementer i saker.
 *
 * Bare elementer fra aktive kilder med lagret tekst grupperes. Elementer som
 * kilden har reservert mot tekst- og datautvinning, analyseres ikke og
 * grupperes derfor ikke. Hvert element havner i nøyaktig én sak; et element
 * som ikke ligner noen åpen sak, starter en ny.
 */
export async function runClusterJob(db: Db, options: ClusterOptions): Promise<ClusterResult> {
  if (processLock.__aiNyheterClusterRunning) {
    return { status: "skipped", reason: "En gruppering kjører allerede" };
  }
  processLock.__aiNyheterClusterRunning = true;
  try {
    return await runLocked(db, options);
  } finally {
    processLock.__aiNyheterClusterRunning = false;
  }
}

export function resolveJudge(config: SiteConfig, judge: JudgeSetup | null | undefined): JudgeSetup | null {
  if (judge !== undefined) return judge;
  if (!config.clustering.useClaudeForBorderline || config.clustering.maxClaudeChecksPerRun === 0) return null;
  const client = createClaudeClient();
  return client ? createClaudeJudge(client, config.ai.model) : null;
}

async function runLocked(db: Db, options: ClusterOptions): Promise<ClusterResult> {
  const now = options.now ?? new Date();
  await failStaleJobRuns(db, now);
  const running = await db.jobRun.findFirst({
    where: { type: "CLUSTER", status: "RUNNING", startedAt: { gte: new Date(now.getTime() - STALE_JOB_MS) } },
  });
  if (running) return { status: "skipped", reason: "En gruppering kjører allerede" };

  const job = await db.jobRun.create({ data: { type: "CLUSTER", trigger: options.trigger, startedAt: now } });
  const judge = resolveJudge(options.config, options.judge);
  try {
    const stats = await cluster(db, options.config, now, judge);
    await db.jobRun.update({
      where: { id: job.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), stats: stats as unknown as Prisma.InputJsonValue },
    });
    return { status: "done", jobId: job.id, stats };
  } catch (error) {
    await db.jobRun.update({
      where: { id: job.id },
      data: { status: "FAILED", finishedAt: new Date(), error: String(error) },
    });
    throw error;
  }
}

const textSelect = {
  id: true,
  title: true,
  excerpt: true,
  bodyText: true,
  publishedAt: true,
  fetchedAt: true,
} as const;
type TextRow = {
  id: string;
  title: string;
  excerpt: string | null;
  bodyText: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
};

/**
 * Tidspunktet elementet sorteres og sammenlignes etter: publiseringstiden,
 * men aldri senere enn da vi hentet det (feeder kan ha feil dato).
 */
export function itemTime(row: { publishedAt: Date | null; fetchedAt: Date }): number {
  const fetched = row.fetchedAt.getTime();
  return row.publishedAt ? Math.min(row.publishedAt.getTime(), fetched) : fetched;
}

function itemText(row: TextRow): ItemText {
  return { title: row.title, excerpt: row.excerpt, bodyText: row.bodyText };
}

async function cluster(db: Db, config: SiteConfig, now: Date, judge: JudgeSetup | null): Promise<ClusterStats> {
  const settings = config.clustering;
  const windowMs = settings.storyWindowHours * 60 * 60 * 1000;
  const stats: ClusterStats = {
    considered: 0,
    newStories: 0,
    joined: 0,
    joinedByClaude: 0,
    newByClaude: 0,
    uncertain: 0,
    skipped: 0,
    claude: judge?.usage ?? null,
    promptVersion: judge?.promptVersion ?? null,
  };

  // Eldste først, så sakene bygges opp i den rekkefølgen kildene kom.
  const candidates = (
    await db.sourceItem.findMany({
      where: { storyId: null, purgedAt: null, tdmReserved: false, source: { status: "ACTIVE" } },
      orderBy: { fetchedAt: "asc" },
      take: settings.maxItemsPerRun,
      select: textSelect,
    })
  ).sort((a, b) => itemTime(a) - itemTime(b) || a.id.localeCompare(b.id));
  if (candidates.length === 0) return stats;

  const first = itemTime(candidates[0]);
  const last = itemTime(candidates[candidates.length - 1]);
  const openStories = await db.story.findMany({
    where: {
      lastSourceAt: { gte: new Date(first - windowMs) },
      firstSeenAt: { lte: new Date(last + windowMs) },
    },
    select: {
      id: true,
      firstSeenAt: true,
      lastSourceAt: true,
      items: { where: { tdmReserved: false }, select: textSelect },
    },
  });

  // Ordvekter fra nyere elementer, pluss alle elementene som skal sammenlignes.
  const reference = await db.sourceItem.findMany({
    where: { tdmReserved: false, fetchedAt: { gte: new Date(now.getTime() - settings.idfWindowDays * DAY_MS) } },
    orderBy: { fetchedAt: "desc" },
    take: MAX_REFERENCE_ITEMS,
    select: textSelect,
  });
  const frequencies = new Map<string, TermVector>();
  for (const row of [...reference, ...candidates, ...openStories.flatMap((s) => s.items)]) {
    if (!frequencies.has(row.id)) frequencies.set(row.id, termFrequencies(itemText(row)));
  }
  const termStats = new TermStats(frequencies.values());
  const toMember = (row: TextRow): Member => ({
    id: row.id,
    time: itemTime(row),
    vector: weigh(frequencies.get(row.id)!, termStats),
    text: itemText(row),
  });

  const clusterer = new Clusterer({
    windowMs,
    sameStoryThreshold: settings.sameStoryThreshold,
    borderlineThreshold: settings.borderlineThreshold,
    judge: judge?.judge ?? null,
    maxJudgeCalls: settings.maxClaudeChecksPerRun,
  });
  for (const story of openStories) {
    clusterer.addStory({
      id: story.id,
      firstAt: story.firstSeenAt.getTime(),
      lastAt: story.lastSourceAt.getTime(),
      members: story.items.map(toMember),
    });
  }

  for (const row of candidates) {
    const member = toMember(row);
    const placement = await clusterer.place(member);
    const saved = await persist(db, row, member, placement, now);
    if (!saved) {
      // En annen prosess grupperte elementet først.
      clusterer.retract(member, placement);
      stats.skipped++;
      continue;
    }
    stats.considered++;
    if (placement.method === "NEW") {
      stats.newStories++;
      if (placement.score !== null && placement.score >= settings.borderlineThreshold) stats.uncertain++;
    } else if (placement.method === "AUTO") stats.joined++;
    else if (placement.method === "CLAUDE") stats.joinedByClaude++;
    else if (placement.method === "CLAUDE_NEW") stats.newByClaude++;
  }
  return stats;
}

/** Lagrer plasseringen. Returnerer false hvis elementet allerede var gruppert. */
async function persist(db: Db, row: TextRow, member: Member, placement: Placement, now: Date): Promise<boolean> {
  const { story } = placement;
  const itemData = {
    clusteredAt: now,
    clusterMethod: placement.method,
    clusterScore: placement.score,
    clusterNote: placement.note ?? null,
    clusterNearestStoryId: placement.isNew ? (placement.nearest?.id ?? null) : null,
  };
  try {
    await db.$transaction(async (tx) => {
      let storyId = story.id;
      if (storyId === null) {
        const slug = await uniqueSlug(
          slugify(row.title),
          async (candidate) => (await tx.story.count({ where: { slug: candidate } })) > 0,
        );
        const created = await tx.story.create({
          data: {
            slug,
            workingTitle: truncate(row.title, 200),
            firstSeenAt: new Date(member.time),
            lastSourceAt: new Date(member.time),
          },
          select: { id: true },
        });
        storyId = created.id;
      } else {
        await tx.story.update({
          where: { id: storyId },
          data: { firstSeenAt: new Date(story.firstAt), lastSourceAt: new Date(story.lastAt) },
        });
      }
      const claimed = await tx.sourceItem.updateMany({
        where: { id: row.id, storyId: null },
        data: { ...itemData, storyId },
      });
      if (claimed.count === 0) throw new AlreadyClustered();
      if (story.id === null) story.id = storyId;
    });
    return true;
  } catch (error) {
    if (error instanceof AlreadyClustered) return false;
    throw error;
  }
}

class AlreadyClustered extends Error {}
