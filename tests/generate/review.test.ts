import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyUsage } from "@/lib/ai/claude";
import type { Db } from "@/lib/db";
import {
  approveArticle,
  regenerateArticle,
  rejectArticle,
  retryStory,
  reviewMessage,
  unpublishArticle,
} from "@/lib/generate/review";
import { runGenerateJob } from "@/lib/generate/run";
import type { WrittenArticle } from "@/lib/generate/schema";
import { getPublishedArticle } from "@/lib/stories";
import { loadCorpus } from "../helpers/cluster-corpus";
import { CORPUS_SOURCES, clusterConfig, insertCorpusItem, sourceIds } from "../helpers/cluster-db";
import { loadGeneratedArticles } from "../helpers/generated-articles";
import { createTestDb } from "../helpers/test-db";
import { vi } from "vitest";

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
const LATER = new Date("2026-10-08T13:00:00Z");
const regn = loadGeneratedArticles().find((s) => s.event === "regn-agder")!;
const code = (c: string) => expect.objectContaining({ code: c });
const base = clusterConfig({}, CORPUS_SOURCES);
const config = { ...base, generation: { ...base.generation, enabled: true } };
/** Skriving er satt opp, uten at testene trenger en ekte nøkkel. */
const rewrite = { config, now: NOW, canWrite: true };

describe("godkjenning av artikler", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  let storyId: string;

  async function generate(article: WrittenArticle) {
    await runGenerateJob(db, {
      config,
      trigger: "test",
      now: NOW,
      agents: {
        writer: {
          write: async () => ({ ok: true, article }),
          usage: emptyUsage(),
          promptVersion: "w",
          model: "claude-test",
        },
        moderator: {
          moderate: async () => ({ ok: true, result: { vurdering: "ok", funn: [], sensitive_temaer: [] } }),
          usage: emptyUsage(),
          promptVersion: "m",
          model: "claude-test",
        },
      },
    });
    return db.article.findFirstOrThrow({ where: { storyId } });
  }

  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    testDb.current = db;
    const ids = await sourceIds(db, clusterConfig({}, CORPUS_SOURCES));
    const story = await db.story.create({
      data: {
        slug: "flom-i-agder",
        workingTitle: "Flom i Agder",
        firstSeenAt: new Date("2026-10-07T10:14:00Z"),
        lastSourceAt: new Date("2026-10-07T15:18:00Z"),
      },
    });
    storyId = story.id;
    for (const item of loadCorpus().filter((i) => i.event === "regn-agder")) {
      const created = await insertCorpusItem(db, ids, item);
      await db.sourceItem.update({ where: { id: created.id }, data: { storyId } });
    }
  });

  afterEach(() => cleanup());

  it("publiserer etter godkjenning, og først da vises artikkelen for lesere", async () => {
    const article = await generate(regn.good);
    expect(await getPublishedArticle("flom-i-agder")).toBeNull();

    await approveArticle(db, article.id, LATER);

    expect(await db.article.findUniqueOrThrow({ where: { id: article.id } })).toMatchObject({
      status: "PUBLISHED",
      publishedAt: LATER,
    });
    expect(await db.moderationReview.findFirstOrThrow()).toMatchObject({
      decision: "APPROVED",
      decidedBy: "ADMIN",
      decidedAt: LATER,
    });
    const page = await getPublishedArticle("flom-i-agder");
    expect(page).toMatchObject({ title: regn.good.tittel, version: 1, approval: { decidedBy: "ADMIN" } });
    // Kildene i tidsrekkefølge, med tittel, lenke og kildeangivelse, men ikke kildeteksten.
    expect(page!.sources.map((s) => s.title)).toEqual(regn.sources.map((s) => s.title));
    expect(page!.sources[0].source.attribution).toBe("Kilde: Testutgiver, CC BY 4.0");
    expect(JSON.stringify(page)).not.toContain(regn.sources[1].text.slice(0, 40));

    await expect(approveArticle(db, article.id, LATER)).rejects.toEqual(code("ikke-til-godkjenning"));
  });

  it("publiserer ikke artikler som bryter faste regler", async () => {
    const copied = regn.variants.find((v) => v.feil === "kopiert_tekst")!.artikkel;
    const article = await generate(copied);
    await expect(approveArticle(db, article.id, LATER)).rejects.toEqual(code("blokkert"));
    expect(await db.article.findUniqueOrThrow({ where: { id: article.id } })).toMatchObject({
      status: "PENDING_REVIEW",
    });
  });

  it("avviser med begrunnelse, og kan skrive avviste og ventende utkast på nytt", async () => {
    const article = await generate(regn.good);
    await expect(rejectArticle(db, article.id, "  ", LATER)).rejects.toEqual(code("mangler-begrunnelse"));
    await expect(rejectArticle(db, article.id, "x".repeat(501), LATER)).rejects.toEqual(code("mangler-begrunnelse"));

    await rejectArticle(db, article.id, "Mangler kommunenavn.", LATER);
    expect(await db.article.findUniqueOrThrow({ where: { id: article.id } })).toMatchObject({ status: "DRAFT" });
    expect(await db.moderationReview.findFirstOrThrow()).toMatchObject({
      decision: "REJECTED",
      decidedBy: "ADMIN",
      decisionNote: "Mangler kommunenavn.",
    });

    await db.story.update({ where: { id: storyId }, data: { generationAttempts: 2 } });
    await regenerateArticle(db, article.id, { ...rewrite, now: new Date("2026-10-10T07:00:00Z") });
    expect(await db.article.count()).toBe(0);
    expect(await db.articleRevision.count()).toBe(0);
    expect(await db.story.findUniqueOrThrow({ where: { id: storyId } })).toMatchObject({ generationAttempts: 0 });
    // Saken er klar for ny skriving.
    expect((await generate(regn.good)).status).toBe("PENDING_REVIEW");
  });

  it("avpubliserer med begrunnelse som en ny versjon i endringsloggen", async () => {
    const article = await generate(regn.good);
    await approveArticle(db, article.id, LATER);
    await expect(unpublishArticle(db, article.id, "", LATER)).rejects.toEqual(code("mangler-begrunnelse"));

    await unpublishArticle(db, article.id, "Feil i kildegrunnlaget.", LATER);

    const after = await db.article.findUniqueOrThrow({
      where: { id: article.id },
      include: { revisions: { orderBy: { version: "asc" }, include: { sources: true } } },
    });
    expect(after).toMatchObject({ status: "UNPUBLISHED", version: 2, unpublishReason: "Feil i kildegrunnlaget." });
    expect(after.revisions.map((r) => [r.version, r.type, r.createdBy])).toEqual([
      [1, "CREATED", "AI"],
      [2, "UNPUBLISHED", "ADMIN"],
    ]);
    expect(after.revisions[1].sources).toHaveLength(after.revisions[0].sources.length);
    expect(await getPublishedArticle("flom-i-agder")).toBeNull();

    // En artikkel som har vært publisert, skrives ikke på nytt her.
    await expect(regenerateArticle(db, article.id, rewrite)).rejects.toEqual(code("har-vaert-publisert"));
    await expect(unpublishArticle(db, article.id, "Igjen.", LATER)).rejects.toEqual(code("ikke-publisert"));
  });

  it("beholder utkastet når saken ikke ville blitt skrevet på nytt", async () => {
    const article = await generate(regn.good);
    await expect(regenerateArticle(db, article.id, { ...rewrite, canWrite: false })).rejects.toEqual(
      code("skriving-av"),
    );
    const old = { ...rewrite, now: new Date("2026-10-12T12:00:00Z") };
    await expect(regenerateArticle(db, article.id, old)).rejects.toEqual(code("for-gammel"));
    // Saken startet 7. oktober kl. 10.14 UTC og er for gammel fra 10. oktober kl. 10.14. Neste kjøring må rekke
    // den, så med mindre enn tre timer igjen beholdes utkastet.
    const almost = { ...rewrite, now: new Date("2026-10-10T07:30:00Z") };
    await expect(regenerateArticle(db, article.id, almost)).rejects.toEqual(code("for-gammel"));
    await db.sourceItem.updateMany({ where: { storyId }, data: { purgedAt: NOW, excerpt: null, bodyText: null } });
    await expect(regenerateArticle(db, article.id, rewrite)).rejects.toEqual(code("for-faa-kilder"));
    expect(await db.article.count()).toBe(1);
  });

  it("prøver en sak der skrivingen har feilet, igjen", async () => {
    await db.story.update({
      where: { id: storyId },
      data: { generationAttempts: 3, lastGenerationError: "Skriving feilet: AuthenticationError (401)" },
    });
    await retryStory(db, storyId, rewrite);
    expect(await db.story.findUniqueOrThrow({ where: { id: storyId } })).toMatchObject({
      generationAttempts: 0,
      lastGenerationError: null,
    });
    await expect(retryStory(db, "finnesikke", rewrite)).rejects.toEqual(code("ukjent-sak"));
    await expect(retryStory(db, storyId, { ...rewrite, canWrite: false })).rejects.toEqual(code("skriving-av"));
    await generate(regn.good);
    await expect(retryStory(db, storyId, rewrite)).rejects.toEqual(code("har-artikkel"));
  });

  it("avviser ukjente artikler", async () => {
    await expect(approveArticle(db, "finnesikke")).rejects.toEqual(code("ukjent-artikkel"));
  });
});

describe("meldinger på godkjenningssiden", () => {
  it("viser bare meldinger for kjente koder", () => {
    expect(reviewMessage("publisert")).toBe("Artikkelen er publisert.");
    expect(reviewMessage("Ring 12345678")).toBeNull();
    expect(reviewMessage("constructor")).toBeNull();
    expect(reviewMessage(["publisert"])).toBeNull();
  });
});
