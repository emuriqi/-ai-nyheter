import type { Metadata } from "next";
import { Suspense } from "react";
import { getStoriesForAdmin } from "@/lib/admin";
import { hasClaudeKey } from "@/lib/ai/claude";
import { siteConfig } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { ARTICLE_STATUS_LABEL, CLUSTER_METHOD_LABEL, label } from "@/lib/labels";
import { detachStoryItem, moveStoryItem } from "../actions";

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
  const { stories, unclustered } = await getStoriesForAdmin();
  const { feil } = await searchParams;
  const error = typeof feil === "string" ? feil.slice(0, 200) : null;
  const { sameStoryThreshold, borderlineThreshold, storyWindowHours, useClaudeForBorderline } = siteConfig.clustering;
  const claudeOn = useClaudeForBorderline && hasClaudeKey();

  return (
    <div>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Kildeelementer om samme hendelse grupperes i én sak. Likhet fra {scoreFormat.format(sameStoryThreshold)} og
        oppover slås sammen automatisk. Mellom {scoreFormat.format(borderlineThreshold)} og{" "}
        {scoreFormat.format(sameStoryThreshold)} er en gråsone:{" "}
        {claudeOn
          ? "der avgjør Claude."
          : "Claude er ikke satt opp, så elementene blir egne saker og merkes som usikre."}{" "}
        En sak tar imot nye kilder i {storyWindowHours} timer etter forrige kilde.
        {unclustered > 0 && ` ${unclustered} elementer venter på neste gruppering.`}
      </p>

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
                          {item.nearest && ` Lignet mest på «${item.nearest.workingTitle}».`}
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
                                  Flytt til «{item.nearest.workingTitle}»
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
