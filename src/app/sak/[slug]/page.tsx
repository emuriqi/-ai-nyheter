import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArticleView } from "@/components/article-view";
import { getPublishedArticle } from "@/lib/stories";

export async function generateMetadata({ params }: PageProps<"/sak/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const article = await getPublishedArticle(slug);
  if (!article) return { title: "Fant ikke saken", robots: { index: false } };
  return {
    title: article.title,
    description: article.lede,
    // Maskinlesbar merking av at teksten er laget av kunstig intelligens (AI-forordningen art. 50).
    other: { "ai-generated": "true", "ai-model": article.model },
  };
}

export default function ArticlePage({ params }: PageProps<"/sak/[slug]">) {
  return (
    <Suspense fallback={<p className="text-muted">Henter saken …</p>}>
      <Article params={params} />
    </Suspense>
  );
}

async function Article({ params }: { params: PageProps<"/sak/[slug]">["params"] }) {
  const { slug } = await params;
  const article = await getPublishedArticle(slug);
  if (!article) notFound();

  return <ArticleView article={article} />;
}
