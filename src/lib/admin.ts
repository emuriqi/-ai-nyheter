import { connection } from "next/server";
import { requireAdmin } from "./auth/require-admin";
import { ANALYZABLE_ITEM } from "./cluster/eligibility";
import { type Finding, isBlocking } from "./generate/findings";
import { STALE_JOB_MS } from "./retention";
import { getDb } from "./db";

// Alle funksjoner her kaller requireAdmin() før de leser data.

/** Tall til admin-oversikten. */
export async function getAdminOverview() {
  await requireAdmin();
  await connection();
  const db = getDb();
  const [sourcesByStatus, itemCount, purgedCount, storyCount, articlesByStatus, pendingReviews, recentJobs] =
    await Promise.all([
      db.source.groupBy({ by: ["status"], _count: { _all: true } }),
      db.sourceItem.count(),
      db.sourceItem.count({ where: { purgedAt: { not: null } } }),
      db.story.count(),
      db.article.groupBy({ by: ["status"], _count: { _all: true } }),
      db.moderationReview.count({ where: { decision: "PENDING" } }),
      db.jobRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    ]);

  return {
    sourcesByStatus: Object.fromEntries(sourcesByStatus.map((row) => [row.status, row._count._all])),
    itemCount,
    purgedCount,
    storyCount,
    articlesByStatus: Object.fromEntries(articlesByStatus.map((row) => [row.status, row._count._all])),
    pendingReviews,
    recentJobs,
  };
}

/** De nyeste hentede elementene, uten selve teksten (bare lengden). */
export async function getRecentItemsForAdmin(limit = 100) {
  await requireAdmin();
  await connection();
  const items = await getDb().sourceItem.findMany({
    orderBy: { fetchedAt: "desc" },
    take: limit,
    select: {
      id: true,
      title: true,
      url: true,
      publishedAt: true,
      fetchedAt: true,
      deleteAfter: true,
      purgedAt: true,
      tdmReserved: true,
      excerpt: true,
      bodyText: true,
      source: { select: { name: true } },
    },
  });
  return items.map(({ excerpt, bodyText, ...item }) => ({
    ...item,
    excerptLength: excerpt?.length ?? 0,
    bodyLength: bodyText?.length ?? 0,
  }));
}

/** Alle kilder med antall hentede elementer. */
export async function getSourcesForAdmin() {
  await requireAdmin();
  await connection();
  return getDb().source.findMany({
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { _count: { select: { items: true } } },
  });
}

/**
 * Sakene fra grupperingen med kildeelementene sine, nyeste først. Teksten
 * vises ikke, bare tittel, lenke og hvordan elementet ble gruppert.
 */
export async function getStoriesForAdmin(limit = 50) {
  await requireAdmin();
  await connection();
  const db = getDb();
  const stories = await db.story.findMany({
    orderBy: { lastSourceAt: "desc" },
    take: limit,
    select: {
      id: true,
      slug: true,
      workingTitle: true,
      firstSeenAt: true,
      lastSourceAt: true,
      article: { select: { status: true, publishedAt: true } },
      items: {
        orderBy: [{ publishedAt: "asc" }, { fetchedAt: "asc" }],
        select: {
          id: true,
          title: true,
          url: true,
          publishedAt: true,
          fetchedAt: true,
          clusterMethod: true,
          clusterScore: true,
          clusterNote: true,
          clusterNearestStoryId: true,
          source: { select: { name: true } },
        },
      },
    },
  });

  const nearestIds = [
    ...new Set(stories.flatMap((s) => s.items.map((i) => i.clusterNearestStoryId)).filter((id): id is string => !!id)),
  ];
  const nearest = await db.story.findMany({
    where: { id: { in: nearestIds } },
    select: { id: true, workingTitle: true, article: { select: { status: true, publishedAt: true } } },
  });
  const nearestById = new Map(nearest.map((s) => [s.id, s]));

  // Samme filter som grupperingen bruker, så tallet bare viser det som faktisk blir gruppert.
  const unclustered = await db.sourceItem.count({ where: { storyId: null, ...ANALYZABLE_ITEM } });

  // En gruppering som kjører (eller har stoppet uten å bli ferdig) sperrer manuell flytting.
  const runningCluster = await db.jobRun.findFirst({
    where: { type: "CLUSTER", status: "RUNNING", startedAt: { gte: new Date(Date.now() - STALE_JOB_MS) } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, trigger: true },
  });

  return {
    unclustered,
    runningCluster,
    stories: stories.map((story) => ({
      ...story,
      /** Har en artikkel som er eller har vært publisert: kildene kan ikke flyttes her. */
      locked: isLocked(story.article),
      items: story.items.map(({ clusterNearestStoryId, ...item }) => {
        const near = clusterNearestStoryId ? nearestById.get(clusterNearestStoryId) : undefined;
        return {
          ...item,
          nearest: near ? { id: near.id, workingTitle: near.workingTitle, locked: isLocked(near.article) } : null,
        };
      }),
    })),
  };
}

/** En sak er låst for flytting når artikkelen er eller har vært publisert. Utkast kan flyttes (de skrives på nytt). */
function isLocked(article: { status: string; publishedAt: Date | null } | null): boolean {
  return article !== null && (article.publishedAt !== null || !["DRAFT", "PENDING_REVIEW"].includes(article.status));
}

const reviewArticleSelect = {
  id: true,
  title: true,
  lede: true,
  body: true,
  status: true,
  version: true,
  model: true,
  promptVersion: true,
  publishedAt: true,
  createdAt: true,
  unpublishReason: true,
  story: { select: { slug: true, workingTitle: true, sensitivity: true, sensitivityReasons: true } },
  revisions: {
    orderBy: { version: "desc" as const },
    take: 1,
    select: {
      version: true,
      createdAt: true,
      moderation: {
        select: { verdict: true, reasons: true, checkedBy: true, decision: true, decidedAt: true, decisionNote: true },
      },
      sources: {
        select: {
          sourceItem: {
            select: { id: true, title: true, url: true, publishedAt: true, source: { select: { publisher: true } } },
          },
        },
      },
    },
  },
};

/**
 * Artiklene til godkjenningssiden: de som venter, de som er avvist, og de
 * som er publisert (for avpublisering). Kildeteksten sendes ikke til siden.
 */
export async function getReviewQueue() {
  await requireAdmin();
  await connection();
  const db = getDb();
  const [pending, rejected, published] = await Promise.all([
    db.article.findMany({
      where: { status: "PENDING_REVIEW" },
      orderBy: { createdAt: "asc" },
      select: reviewArticleSelect,
    }),
    db.article.findMany({
      where: { status: "DRAFT" },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: reviewArticleSelect,
    }),
    db.article.findMany({
      where: { status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
      take: 20,
      select: reviewArticleSelect,
    }),
  ]);
  const failed = await db.story.findMany({
    where: { article: null, lastGenerationError: { not: null } },
    orderBy: { lastGenerationAt: "desc" },
    take: 20,
    select: {
      slug: true,
      workingTitle: true,
      generationAttempts: true,
      lastGenerationAt: true,
      lastGenerationError: true,
    },
  });
  const shape = (a: (typeof pending)[number]) => {
    const [latest] = a.revisions;
    const findings = (latest?.moderation?.reasons as Finding[] | null) ?? [];
    return {
      ...a,
      latest,
      findings,
      blocked: isBlocking(findings),
      sources: (latest?.sources ?? []).map((s) => s.sourceItem),
    };
  };
  return { pending: pending.map(shape), rejected: rejected.map(shape), published: published.map(shape), failed };
}
