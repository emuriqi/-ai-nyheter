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
      version: true,
      isCorrected: true,
      story: { select: { slug: true } },
      revisions: {
        orderBy: { version: "desc" },
        take: 1,
        select: { createdAt: true, _count: { select: { sources: true } } },
      },
    },
  });
}

/**
 * En publisert artikkel til artikkelsiden, med kildene i gjeldende versjon og
 * hele endringsloggen. Upubliserte og avpubliserte artikler gir null.
 */
export async function getPublishedArticle(slug: string) {
  await connection();
  const story = await getDb().story.findUnique({
    where: { slug },
    select: {
      slug: true,
      article: {
        select: {
          id: true,
          title: true,
          lede: true,
          body: true,
          status: true,
          version: true,
          isCorrected: true,
          model: true,
          publishedAt: true,
          revisions: {
            orderBy: { version: "desc" },
            select: {
              version: true,
              type: true,
              changeSummary: true,
              reason: true,
              createdAt: true,
              createdBy: true,
              moderation: { select: { decision: true, decidedBy: true, decidedAt: true } },
              sources: {
                select: {
                  sourceItem: {
                    select: {
                      id: true,
                      title: true,
                      url: true,
                      publishedAt: true,
                      fetchedAt: true,
                      source: { select: { name: true, publisher: true, attribution: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const article = story?.article;
  if (!article || article.status !== "PUBLISHED") return null;
  const [current] = article.revisions;
  const sources = (current?.sources ?? [])
    .map((s) => s.sourceItem)
    .sort((a, b) => (a.publishedAt ?? a.fetchedAt).getTime() - (b.publishedAt ?? b.fetchedAt).getTime());
  // Hvem som godkjente: første versjon som ble godkjent.
  const approval = [...article.revisions].reverse().find((r) => r.moderation?.decision === "APPROVED")?.moderation;
  return { slug: story.slug, ...article, sources, approval: approval ?? null };
}

export type PublishedArticle = NonNullable<Awaited<ReturnType<typeof getPublishedArticle>>>;
