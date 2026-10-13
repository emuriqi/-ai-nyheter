import type { Metadata } from "next";
import { Suspense } from "react";
import { getStoriesForAdmin } from "@/lib/admin";
import { hasClaudeKey } from "@/lib/ai/claude";
import { siteConfig } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { manualErrorMessage } from "@/lib/cluster/manual";
import { ARTICLE_STATUS_LABEL, CLUSTER_METHOD_LABEL, label } from "@/lib/labels";
import { abortClustering, detachStoryItem, moveStoryItem } from "../actions";

export const metadata: Metadata = { title: "Saker" };

const scoreFormat = new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Rundes ned, så en likhet like under grensen (0,3996) ikke vises som grensen (0,40). */
const formatScore = (score: number) => scoreFormat.format(Math.floor(score * 100) / 100);

export default function AdminStoriesPage({ searchParams }: PageProps<"/admin/saker">) {
  return (
    <div>
      <h1 className="font-serif text-2xl font-bold">Saker</h1>
      <Suspense fallback={<p className="mt-6 text-muted">Laster …</p>}>
        <StoryList searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function StoryList({ searchParams }: { searchParams: PageProps<"/admin/saker">["searchParams"] }) {
  const { stories, unclustered, runningCluster } = await getStoriesForAdmin();
  const { feil } = await searchParams;
  // Bare kjente koder vises. Fritekst fra adressen vises aldri.
  const error = manualErrorMessage(feil);
  const { sameStoryThreshold, borderlineThreshold, storyWindowHours, maxStoryHours, useClaudeForBorderline } =
    siteConfig.clustering;
  const claudeOn = useClaudeForBorderline && hasClaudeKey();

  return (
    <div>
      <div className="mt-2 max-w-3xl space-y-2 text-sm text-muted">
        <p>
          Kildeelementer om samme hendelse grupperes i én sak. Et element slås sammen automatisk når likheten med et
          element fra <em>en annen kilde</em> i den mest like saken er minst {scoreFormat.format(sameStoryThreshold)}.
        </p>
        <p>
          Likhet mellom {scoreFormat.format(borderlineThreshold)} og {scoreFormat.format(sameStoryThreshold)}, og høy
          likhet som bare er med elementer fra samme kilde, er en gråsone, fordi en kilde ofte bruker faste maler.{" "}
          {claudeOn
            ? "I gråsonen avgjør Claude."
            : "Claude er ikke satt opp, så elementer i gråsonen blir egne saker og merkes som usikre."}
        </p>
        <p>
          En sak tar imot nye kilder i {storyWindowHours} timer etter forrige kilde, og dekker høyst{" "}
          {Math.round(maxStoryHours / 24)} døgn.
          {unclustered > 0 && ` ${unclustered} elementer venter på neste gruppering.`}
        </p>
      </div>

      {runningCluster && (
        <div role="status" className="mt-4 rounded-lg border border-notice-border bg-notice p-4 text-sm">
          <p>
            Grupperingen har kjørt siden {formatDateTime(runningCluster.startedAt)} ({runningCluster.trigger}). Flytting
            er sperret til den er ferdig. Har den stoppet uten å bli ferdig, for eksempel etter en omstart, kan du
            markere den som avbrutt.
          </p>
          <form action={abortClustering} className="mt-2">
            <button type="submit" className="rounded border border-border px-2 py-1 text-xs hover:border-foreground">
              Marker som avbrutt
            </button>
          </form>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-notice-border bg-notice p-4 text-sm">
          {error}
        </p>
      )}

      {stories.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border p-6 text-muted">
          Ingen saker ennå. Saker lages når innhentingen har hentet elementer fra aktive kilder.
        </p>
      ) : (
        <ul className="mt-6 space-y-6">
          {stories.map((story) => {
            const locked = story.article !== null;
            return (
              <li key={story.id} className="rounded-lg border border-border p-4">
                <h2 className="font-semibold">{story.workingTitle}</h2>
                <p className="mt-1 text-xs text-muted">
                  {story.items.length} {story.items.length === 1 ? "kilde" : "kilder"} ·{" "}
                  {formatDateTime(story.firstSeenAt)} – {formatDateTime(story.lastSourceAt)} · {story.slug}
                  {story.article && ` · Artikkel: ${label(ARTICLE_STATUS_LABEL, story.article.status)}`}
                </p>
                <ul className="mt-3 space-y-3 text-sm">
                  {story.items.map((item) => {
                    const uncertain =
                      item.clusterMethod === "NEW" &&
                      item.clusterScore !== null &&
                      item.clusterScore >= borderlineThreshold;
                    const canMove = !locked && item.nearest !== null && !item.nearest.hasArticle;
                    return (
                      <li key={item.id} className="border-t border-border pt-3">
                        <a href={item.url} className="text-accent hover:underline" rel="noopener noreferrer">
                          {item.title}
                        </a>
                        <span className="text-muted">
                          {" "}
                          · {item.source.name} · {formatDateTime(item.publishedAt ?? item.fetchedAt)}
                        </span>
                        <p className="mt-1 text-xs text-muted">
                          {uncertain && <strong className="mr-1 text-foreground">Usikker.</strong>}
                          {item.clusterMethod ? label(CLUSTER_METHOD_LABEL, item.clusterMethod) : "Ikke gruppert"}
                          {item.clusterScore !== null && ` (likhet ${formatScore(item.clusterScore)})`}
                          {item.clusterNote && ` – «${item.clusterNote}»`}
                          {item.nearest &&
                            (item.clusterMethod === "MANUAL"
                              ? `. Kom fra «${item.nearest.workingTitle}».`
                              : `. Lignet mest på «${item.nearest.workingTitle}».`)}
                        </p>
                        {!locked && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {story.items.length > 1 && (
                              <form action={detachStoryItem}>
                                <input type="hidden" name="itemId" value={item.id} />
                                <button
                                  type="submit"
                                  className="rounded border border-border px-2 py-1 text-xs hover:border-foreground"
                                >
                                  Skill ut som egen sak
                                </button>
                              </form>
                            )}
                            {canMove && item.nearest && (
                              <form action={moveStoryItem}>
                                <input type="hidden" name="itemId" value={item.id} />
                                <input type="hidden" name="storyId" value={item.nearest.id} />
                                <button
                                  type="submit"
                                  className="rounded border border-border px-2 py-1 text-xs hover:border-foreground"
                                >
                                  {item.clusterMethod === "MANUAL" ? "Flytt tilbake til" : "Flytt til"} «
                                  {item.nearest.workingTitle}»
                                </button>
                              </form>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
