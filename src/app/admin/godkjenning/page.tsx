import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArticleBody } from "@/components/article-body";
import { getReviewQueue } from "@/lib/admin";
import { siteConfig } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import type { Finding } from "@/lib/generate/findings";
import { reviewMessage } from "@/lib/generate/review";
import { approveArticleAction, regenerateArticleAction, rejectArticleAction, unpublishArticleAction } from "../actions";

export const metadata: Metadata = { title: "Godkjenning" };

type QueueArticle = Awaited<ReturnType<typeof getReviewQueue>>["pending"][number];

const GROUPS: { title: string; severities: Finding["severity"][] }[] = [
  { title: "Hindrer publisering", severities: ["blokkerer"] },
  { title: "Må vurderes", severities: ["høy", "middels"] },
  { title: "Til orientering", severities: ["lav", "info"] },
];

const ORIGIN_LABEL: Record<Finding["origin"], string> = {
  kontroll: "Automatisk kontroll",
  moderering: "AI-moderering",
  skriver: "Skriveren",
};

const button = "rounded border border-border px-3 py-1 text-sm hover:border-foreground disabled:opacity-50";

export default function ReviewPage({ searchParams }: PageProps<"/admin/godkjenning">) {
  return (
    <div>
      <h1 className="font-serif text-2xl font-bold">Godkjenning</h1>
      <Suspense fallback={<p className="mt-6 text-muted">Laster …</p>}>
        <Queue searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Queue({ searchParams }: { searchParams: PageProps<"/admin/godkjenning">["searchParams"] }) {
  const { pending, rejected, published, failed } = await getReviewQueue();
  const { melding } = await searchParams;
  // Bare kjente koder vises. Fritekst fra adressen vises aldri.
  const message = reviewMessage(melding);
  const { editor, editorial } = siteConfig;

  return (
    <div className="space-y-10">
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Artiklene er skrevet av Claude ut fra kildene og kontrollert automatisk og av en egen AI-moderering.{" "}
        {editorial.manualApproval === "ALL"
          ? "Alle artikler må godkjennes her før de publiseres."
          : "Artikler uten funn publiseres automatisk; flaggede artikler må godkjennes her."}{" "}
        Artikler som bryter faste regler (for langt eller oppdiktet sitat, kopiert tekst, privatperson, ukjent kilde),
        kan ikke publiseres.
      </p>

      {editor.isPlaceholder && (
        <p role="note" className="rounded-lg border border-notice-border bg-notice p-4 text-sm">
          Ansvarlig redaktør er ikke utpekt (se editor i config/site.config.ts). Et nettsted som publiserer nyheter, må
          ha en ansvarlig redaktør.
        </p>
      )}

      {message && (
        <p role="status" className="rounded-lg border border-notice-border bg-notice p-4 text-sm">
          {message}
        </p>
      )}

      <section>
        <h2 className="font-semibold">Venter på godkjenning ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Ingen artikler venter.</p>
        ) : (
          <ul className="mt-4 space-y-8">
            {pending.map((article) => (
              <li key={article.id}>
                <ReviewCard article={article} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {failed.length > 0 && (
        <section>
          <h2 className="font-semibold">Saker der skrivingen feilet</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {failed.map((story) => (
              <li key={story.slug}>
                {story.workingTitle}{" "}
                <span className="text-muted">
                  · {story.generationAttempts} {story.generationAttempts === 1 ? "forsøk" : "forsøk"} · sist{" "}
                  {formatDateTime(story.lastGenerationAt)} · {story.lastGenerationError}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="font-semibold">Avvist</h2>
        {rejected.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Ingen avviste artikler.</p>
        ) : (
          <ul className="mt-2 space-y-3 text-sm">
            {rejected.map((article) => (
              <li key={article.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{article.title}</span>
                <span className="text-muted">
                  {article.latest?.moderation?.decisionNote && `Begrunnelse: ${article.latest.moderation.decisionNote}`}
                </span>
                <form action={regenerateArticleAction}>
                  <input type="hidden" name="articleId" value={article.id} />
                  <button type="submit" className={button}>
                    Skriv på nytt
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-semibold">Publisert</h2>
        {published.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Ingen publiserte artikler.</p>
        ) : (
          <ul className="mt-2 space-y-4 text-sm">
            {published.map((article) => (
              <li key={article.id}>
                <Link href={`/sak/${article.story.slug}`} className="text-accent hover:underline">
                  {article.title}
                </Link>
                <span className="text-muted"> · publisert {formatDateTime(article.publishedAt)}</span>
                <form action={unpublishArticleAction} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="articleId" value={article.id} />
                  <label className="flex min-w-0 flex-1 flex-col text-xs text-muted">
                    Begrunnelse for avpublisering
                    <input
                      name="note"
                      required
                      maxLength={500}
                      className="mt-1 rounded border border-border px-2 py-1"
                    />
                  </label>
                  <button type="submit" className={button}>
                    Avpubliser
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ReviewCard({ article }: { article: QueueArticle }) {
  const moderation = article.latest?.moderation;
  return (
    <article className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted">
        {article.story.workingTitle} · skrevet {formatDateTime(article.createdAt)} · {article.model} ·{" "}
        {moderation?.checkedBy === "AI" ? "kontrollert av AI-moderering" : "bare automatisk kontroll"}
        {article.story.sensitivity === "SENSITIVE" && <strong className="text-foreground"> · Sensitiv sak</strong>}
      </p>

      <div className="mt-3 space-y-3">
        {GROUPS.map((group) => {
          const findings = article.findings.filter((f) => group.severities.includes(f.severity));
          if (findings.length === 0) return null;
          return (
            <div key={group.title}>
              <h3 className="text-sm font-semibold">{group.title}</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {findings.map((f, i) => (
                  <li key={i}>
                    <span className="text-muted">{ORIGIN_LABEL[f.origin]}:</span> {f.message}
                    {f.excerpt && <span className="text-muted"> («{f.excerpt}»)</span>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {article.findings.length === 0 && <p className="text-sm text-muted">Ingen funn i kontrollene.</p>}
      </div>

      <div className="mt-6 border-t border-border pt-4">
        <h3 className="font-serif text-2xl font-bold leading-tight">{article.title}</h3>
        <p className="mt-2 text-lg">{article.lede}</p>
        <div className="mt-4">
          <ArticleBody body={article.body} />
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">Kilder ({article.sources.length})</h3>
        <ul className="mt-1 space-y-1 text-sm">
          {article.sources.map((s) => (
            <li key={s.id}>
              <a href={s.url} className="text-accent hover:underline" rel="noopener noreferrer">
                {s.title}
              </a>
              <span className="text-muted">
                {" "}
                · {s.source.publisher} · {formatDateTime(s.publishedAt)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-border pt-4">
        <form action={approveArticleAction}>
          <input type="hidden" name="articleId" value={article.id} />
          <button type="submit" className={button} disabled={article.blocked}>
            Godkjenn og publiser
          </button>
        </form>
        <form action={regenerateArticleAction}>
          <input type="hidden" name="articleId" value={article.id} />
          <button type="submit" className={button}>
            Skriv på nytt
          </button>
        </form>
        <form action={rejectArticleAction} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
          <input type="hidden" name="articleId" value={article.id} />
          <label className="flex min-w-0 flex-1 flex-col text-xs text-muted">
            Begrunnelse for avvisning
            <input name="note" required maxLength={500} className="mt-1 rounded border border-border px-2 py-1" />
          </label>
          <button type="submit" className={button}>
            Avvis
          </button>
        </form>
      </div>
      {article.blocked && (
        <p className="mt-2 text-sm">
          Artikkelen bryter faste regler og kan ikke publiseres. Skriv den på nytt eller avvis den.
        </p>
      )}
    </article>
  );
}
