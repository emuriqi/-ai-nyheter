import { connection } from "next/server";
import { getDb } from "./db";

/** Tall til admin-oversikten. */
export async function getAdminOverview() {
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

/** Alle kilder med antall hentede elementer. */
export async function getSourcesForAdmin() {
  await connection();
  return getDb().source.findMany({
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { _count: { select: { items: true } } },
  });
}
