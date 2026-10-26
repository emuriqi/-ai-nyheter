import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ArticleLayout from "@/app/sak/[slug]/layout";
import { generateMetadata } from "@/app/sak/[slug]/page";
import { ArticleView } from "@/components/article-view";
import { emptyUsage } from "@/lib/ai/claude";
import { siteConfig } from "@/lib/config";
import type { Db } from "@/lib/db";
import type { ModerateOutcome } from "@/lib/generate/claude";
import { approveArticle } from "@/lib/generate/review";
import { runGenerateJob } from "@/lib/generate/run";
import { getPublishedArticle } from "@/lib/stories";
import { loadCorpus } from "./helpers/cluster-corpus";
import { CORPUS_SOURCES, clusterConfig, insertCorpusItem, sourceIds } from "./helpers/cluster-db";
import { loadGeneratedArticles } from "./helpers/generated-articles";
import { createTestDb } from "./helpers/test-db";

const testDb = vi.hoisted(() => ({ current: null as Db | null }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => testDb.current,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: vi.fn(async () => undefined),
}));

const NOW = new Date("2026-10-08T12:00:00Z");
const APPROVED = new Date("2026-10-08T14:00:00Z");
const regn = loadGeneratedArticles().find((s) => s.event === "regn-agder")!;
const params = (slug: string) => ({ params: Promise.resolve({ slug }) }) as Parameters<typeof generateMetadata>[0];

/** Artikkelsiden for en publisert artikkel: AI-merking synlig og maskinlesbart, kilder og hvordan saken ble laget. */
describe("artikkelsiden", () => {
  let db: Db;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    testDb.current = db;
    const base = clusterConfig({}, CORPUS_SOURCES);
    const ids = await sourceIds(db, base);
    const story = await db.story.create({
      data: {
        slug: "flom-i-agder",
        workingTitle: "Flom i Agder",
        firstSeenAt: new Date("2026-10-07T10:14:00Z"),
        lastSourceAt: new Date("2026-10-07T15:18:00Z"),
      },
    });
    for (const item of loadCorpus().filter((i) => i.event === "regn-agder")) {
      const created = await insertCorpusItem(db, ids, item);
      await db.sourceItem.update({ where: { id: created.id }, data: { storyId: story.id } });
    }
  });

  afterEach(() => cleanup());

  async function publish(moderation: ModerateOutcome) {
    const base = clusterConfig({}, CORPUS_SOURCES);
    await runGenerateJob(db, {
      config: { ...base, generation: { ...base.generation, enabled: true } },
      trigger: "test",
      now: NOW,
      agents: {
        writer: {
          write: async () => ({ ok: true, article: regn.good }),
          usage: emptyUsage(),
          promptVersion: "w",
          model: "claude-test",
        },
        moderator: { moderate: async () => moderation, usage: emptyUsage(), promptVersion: "m", model: "claude-test" },
      },
    });
    const article = await db.article.findFirstOrThrow();
    await approveArticle(db, article.id, APPROVED);
    return (await getPublishedArticle("flom-i-agder"))!;
  }

  const render = async (moderation: ModerateOutcome) =>
    renderToStaticMarkup(createElement(ArticleView, { article: await publish(moderation) }));
  const moderated: ModerateOutcome = { ok: true, result: { vurdering: "ok", funn: [], sensitive_temaer: [] } };

  it("merker teksten som AI-generert, synlig og i strukturerte data", async () => {
    const html = await render(moderated);
    expect(html).toContain(`<p role="note"`);
    expect(html).toContain(siteConfig.ai.articleLabel);
    const json = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]);
    expect(json).toMatchObject({
      "@type": "NewsArticle",
      headline: regn.good.tittel,
      creator: { "@type": "SoftwareApplication", name: "claude-test" },
      datePublished: APPROVED.toISOString(),
      // Første versjon er skrevet før den ble godkjent, så endringen regnes fra publiseringen.
      dateModified: APPROVED.toISOString(),
    });
    expect(json.isBasedOn).toHaveLength(4);
  });

  it("lister og krediterer kildene, men viser ikke kildeteksten", async () => {
    const html = await render(moderated);
    for (const source of regn.sources) expect(html).toContain(source.title);
    expect(html).toContain("Kilde: Testutgiver, CC BY 4.0");
    expect(html).not.toContain(regn.sources[1].text.slice(0, 40));
  });

  it("forteller hvordan saken ble kontrollert og godkjent", async () => {
    expect(await render(moderated)).toContain("kontrollert automatisk og av en egen AI-moderering mot kildene");
  });

  it("sier fra når AI-modereringen ikke kunne gjennomføres", async () => {
    const html = await render({ ok: false, reason: "Moderering uten svar: svaret kunne ikke tolkes", stopRun: false });
    expect(html).toContain("kontrollert automatisk mot kildene (AI-modereringen kunne ikke gjennomføres)");
    expect(html).not.toContain("av en egen AI-moderering");
    expect(html).toContain("godkjent av redaktøren");
  });

  it("har maskinlesbar AI-merking i den statiske layouten, så den alltid står i <head>", () => {
    const html = renderToStaticMarkup(createElement(ArticleLayout, { children: "innhold" } as never));
    expect(html).toContain('<meta name="ai-generated" content="true"/>');
  });

  it("har modellen i metadata, og noindex for saker som ikke finnes", async () => {
    await publish(moderated);
    expect(await generateMetadata(params("flom-i-agder"))).toMatchObject({
      title: regn.good.tittel,
      description: regn.good.ingress,
      other: { "ai-model": "claude-test" },
    });
    expect(await generateMetadata(params("finnes-ikke"))).toEqual({
      title: "Fant ikke saken",
      robots: { index: false },
    });
  });
});
