import { connection } from "next/server";
import { requireAdmin } from "./auth/require-admin";
import { ANALYZABLE_ITEM } from "./cluster/eligibility";
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
      article: { select: { status: true } },
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
    select: { id: true, workingTitle: true, article: { select: { id: true } } },
  });
  const nearestById = new Map(nearest.map((s) => [s.id, s]));

  // Samme filter som grupperingen bruker, så tallet bare viser det som faktisk blir gruppert.
  const unclustered = await db.sourceItem.count({ where: { storyId: null, ...ANALYZABLE_ITEM } });

  return {
    unclustered,
    stories: stories.map((story) => ({
      ...story,
      items: story.items.map(({ clusterNearestStoryId, ...item }) => {
        const near = clusterNearestStoryId ? nearestById.get(clusterNearestStoryId) : undefined;
        return {
          ...item,
          nearest: near ? { id: near.id, workingTitle: near.workingTitle, hasArticle: near.article !== null } : null,
        };
      }),
    })),
  };
}
