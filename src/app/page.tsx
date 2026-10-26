import Link from "next/link";
import { Suspense } from "react";
import { formatDateTime } from "@/lib/format";
import { getPublishedArticles } from "@/lib/stories";

export default function HomePage() {
  return (
    <>
      {/* Forsiden viser titler og ingresser skrevet av kunstig intelligens (AI-forordningen art. 50). */}
      <meta name="ai-generated" content="true" />
      <h1 className="sr-only">Siste saker</h1>
      <Suspense fallback={<p className="text-muted">Henter saker …</p>}>
        <ArticleList />
      </Suspense>
    </>
  );
}

async function ArticleList() {
  const articles = await getPublishedArticles();

  if (articles.length === 0) {
    return (
      <section className="rounded-lg border border-border p-8 text-center">
        <h2 className="font-serif text-xl font-semibold">Ingen publiserte saker ennå</h2>
        <p className="mt-2 text-muted">
          Saker dukker opp her når kilder er hentet inn, artikler er skrevet og moderasjonen har godkjent
          dem.
        </p>
      </section>
    );
  }

  return (
    <ol className="divide-y divide-border">
      {articles.map((article) => (
        <ArticleListItem key={article.id} article={article} />
      ))}
    </ol>
  );
}

type ArticleSummary = Awaited<ReturnType<typeof getPublishedArticles>>[number];

function ArticleListItem({ article }: { article: ArticleSummary }) {
  // Gjeldende versjon: når innholdet sist endret seg og hvor mange kilder den bygger på.
  const current = article.revisions[0];
  const sourceCount = current?._count.sources ?? 0;

  return (
    <li className="py-6 first:pt-0">
      <article>
        <h2 className="font-serif text-2xl font-bold leading-tight">
          <Link href={`/sak/${article.story.slug}`} className="hover:underline">
            {article.title}
          </Link>
        </h2>
        <p className="mt-2 text-lg">{article.lede}</p>
        <p className="mt-2 text-sm text-muted">
          <span>Publisert {formatDateTime(article.publishedAt)}</span>
          {article.version > 1 && current && <span> · Oppdatert {formatDateTime(current.createdAt)}</span>}
          {article.isCorrected && <span className="font-semibold"> · Rettet</span>}
          <span> · {sourceCount === 1 ? "1 kilde" : `${sourceCount} kilder`}</span>
          <span> · AI-generert</span>
        </p>
      </article>
    </li>
  );
}
