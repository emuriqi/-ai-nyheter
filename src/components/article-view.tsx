import { ArticleBody } from "@/components/article-body";
import { siteConfig } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import type { PublishedArticle } from "@/lib/stories";

const REVISION_LABEL: Record<string, string> = {
  CREATED: "Første versjon",
  NEW_SOURCES: "Oppdatert med nye kilder",
  CORRECTION: "Rettet",
  EDITORIAL: "Redigert",
  UNPUBLISHED: "Avpublisert",
  REPUBLISHED: "Publisert igjen",
};

/**
 * Artikkelsiden for en publisert artikkel: synlig AI-merking, teksten,
 * kildene med kreditering, hvordan saken ble laget, endringsloggen og
 * strukturerte data. Kildeteksten vises aldri.
 */
export function ArticleView({ article }: { article: PublishedArticle }) {
  return (
    <article className="mx-auto max-w-2xl">
      <JsonLd article={article} />
      <p role="note" className="rounded-lg border border-notice-border bg-notice p-3 text-sm">
        {siteConfig.ai.articleLabel}
      </p>

      <h1 className="mt-6 font-serif text-3xl font-bold leading-tight sm:text-4xl">{article.title}</h1>
      <p className="mt-4 text-xl leading-relaxed">{article.lede}</p>
      <p className="mt-4 text-sm text-muted">
        Publisert {formatDateTime(article.publishedAt)}
        {article.version > 1 && ` · Oppdatert ${formatDateTime(article.revisions[0].createdAt)}`}
        {article.isCorrected && <strong className="text-foreground"> · Rettet</strong>}
        {` · Versjon ${article.version}`}
      </p>

      <div className="mt-8">
        <ArticleBody body={article.body} />
      </div>

      <section aria-labelledby="kilder" className="mt-12 border-t border-border pt-6">
        <h2 id="kilder" className="font-serif text-xl font-semibold">
          Kilder
        </h2>
        <p className="mt-1 text-sm text-muted">
          Artikkelen bygger bare på disse kildene. Følg lenkene for å lese originalene.
        </p>
        <ul className="mt-4 space-y-3">
          {article.sources.map((item) => (
            <li key={item.id}>
              <a href={item.url} className="text-accent hover:underline" rel="noopener noreferrer">
                {item.title}
              </a>
              <span className="block text-sm text-muted">
                {item.source.publisher} · {formatDateTime(item.publishedAt ?? item.fetchedAt)} ·{" "}
                {item.source.attribution}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="slik" className="mt-10 border-t border-border pt-6">
        <h2 id="slik" className="font-serif text-xl font-semibold">
          Slik ble saken laget
        </h2>
        <p className="mt-2 text-sm leading-relaxed">
          Teksten er skrevet av kunstig intelligens ({siteConfig.ai.provider}, {article.model}) ut fra kildene over.{" "}
          {article.checkedBy === "AI"
            ? "Den er kontrollert automatisk og av en egen AI-moderering mot kildene,"
            : "Den er kontrollert automatisk mot kildene (AI-modereringen kunne ikke gjennomføres),"}{" "}
          {article.approval?.decidedBy === "ADMIN"
            ? "og godkjent av redaktøren før publisering."
            : "og publisert automatisk fordi kontrollene ikke fant noe som måtte vurderes av en redaktør."}{" "}
          Ser du en feil, ta kontakt med redaksjonen.
        </p>
      </section>

      <section aria-labelledby="endringer" className="mt-10 border-t border-border pt-6">
        <h2 id="endringer" className="font-serif text-xl font-semibold">
          Endringslogg
        </h2>
        <ol className="mt-4 space-y-3 text-sm">
          {article.revisions.map((revision) => (
            <li key={revision.version}>
              <span className="font-semibold">
                Versjon {revision.version}: {REVISION_LABEL[revision.type] ?? revision.type}
              </span>{" "}
              <span className="text-muted">{formatDateTime(revision.createdAt)}</span>
              {revision.type !== "CREATED" && (
                <span className="block">
                  {revision.changeSummary}. {revision.reason}
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

/**
 * Når artikkelen sist ble endret for leserne: den siste av publiseringen og
 * siste versjon. Første versjon skrives før den godkjennes og publiseres.
 */
function lastModified(article: PublishedArticle): Date | undefined {
  const times = [article.publishedAt, article.revisions[0]?.createdAt].filter((d): d is Date => d instanceof Date);
  return times.length > 0 ? new Date(Math.max(...times.map((d) => d.getTime()))) : undefined;
}

/**
 * Strukturerte data (schema.org) for søkemotorer og andre maskiner: hvem som
 * laget teksten (programvare, ikke en person) og hvilke kilder den bygger på.
 */
function JsonLd({ article }: { article: PublishedArticle }) {
  const data = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: article.title,
    description: article.lede,
    datePublished: article.publishedAt?.toISOString(),
    dateModified: lastModified(article)?.toISOString(),
    inLanguage: "nb",
    creator: { "@type": "SoftwareApplication", name: article.model, provider: siteConfig.ai.provider },
    isBasedOn: article.sources.map((s) => s.url),
    publisher: { "@type": "Organization", name: siteConfig.site.name },
  };
  // JSON i et script-element: < escapes så teksten ikke kan avslutte elementet.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
