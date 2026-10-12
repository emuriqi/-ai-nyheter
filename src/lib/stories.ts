import { connection } from "next/server";
import { getDb } from "./db";

/** Nyeste publiserte saker til forsiden. */
export async function getPublishedArticles(limit = 20) {
  await connection();
  return getDb().article.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { publishedAt: "desc" },
    take: limit,
    select: {
      id: true,
      title: true,
      lede: true,
      publishedAt: true,
      updatedAt: true,
      version: true,
      isCorrected: true,
      story: { select: { slug: true, _count: { select: { items: true } } } },
    },
  });
}
