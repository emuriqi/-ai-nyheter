import { connection } from "next/server";
import { requireAdmin } from "./auth/require-admin";
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
