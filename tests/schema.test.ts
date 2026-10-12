import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { createTestDb } from "./helpers/test-db";

/** Røyktest av datamodellen: hele kjeden fra kilde til endringslogg. */
describe("datamodell", () => {
  let db: Db;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    ({ db, cleanup } = createTestDb());
  });

  afterAll(() => cleanup());

  async function createChain(suffix: string) {
    const source = await db.source.create({
      data: {
        slug: `kilde-${suffix}`,
        name: "Kilde",
        publisher: "Utgiver",
        kind: "RSS",
        homepageUrl: "https://example.no/",
        termsUrl: "https://example.no/vilkar",
        license: "NLOD-2.0",
        licenseNote: "Åpen",
        attribution: "Kilde",
        language: "nb",
        status: "ACTIVE",
        tdmReservation: "NONE_FOUND",
      },
    });
    const story = await db.story.create({
      data: {
        slug: `sak-${suffix}`,
        workingTitle: "Arbeidstittel",
        sensitivity: "SENSITIVE",
        sensitivityReasons: ["helse"],
      },
    });
    const item = await db.sourceItem.create({
      data: {
        sourceId: source.id,
        storyId: story.id,
        guid: `guid-${suffix}`,
        url: "https://example.no/sak",
        title: "Kildetittel",
        bodyText: "Tekst",
        language: "nb",
        deleteAfter: new Date("2026-11-11T00:00:00Z"),
      },
    });
    const article = await db.article.create({
      data: {
        storyId: story.id,
        title: "Tittel",
        lede: "Ingress",
        body: "Brødtekst",
        model: "claude-sonnet-5-5",
        promptVersion: "v1",
        revisions: {
          create: {
            version: 1,
            type: "CREATED",
            title: "Tittel",
            lede: "Ingress",
            body: "Brødtekst",
            changeSummary: "Første versjon",
            reason: "Ny sak",
            createdBy: "AI",
            sources: { create: { sourceItemId: item.id } },
            moderation: {
              create: { verdict: "FLAGGED", reasons: ["sensitivt tema: helse"], checkedBy: "AI" },
            },
          },
        },
      },
    });
    return { source, story, item, article };
  }

  it("lagrer hele kjeden fra kilde til endringslogg med moderering", async () => {
    const { article, story } = await createChain("a");

    const loaded = await db.article.findUniqueOrThrow({
      where: { id: article.id },
      include: { revisions: { include: { sources: true, moderation: true } } },
    });
    expect(loaded.aiGenerated).toBe(true);
    expect(loaded.status).toBe("DRAFT");
    expect(loaded.revisions).toHaveLength(1);
    expect(loaded.revisions[0].sources).toHaveLength(1);
    expect(loaded.revisions[0].moderation?.decision).toBe("PENDING");
    expect(loaded.revisions[0].moderation?.reasons).toEqual(["sensitivt tema: helse"]);

    const loadedStory = await db.story.findUniqueOrThrow({ where: { id: story.id } });
    expect(loadedStory.sensitivityReasons).toEqual(["helse"]);
  });

  it("hindrer duplikate elementer fra samme kilde", async () => {
    const { item } = await createChain("b");
    await expect(
      db.sourceItem.create({
        data: {
          sourceId: item.sourceId,
          guid: item.guid,
          url: item.url,
          title: "Duplikat",
          language: "nb",
          deleteAfter: item.deleteAfter,
        },
      }),
    ).rejects.toThrow();
  });

  it("hindrer sletting av kildeelementer som en artikkelversjon bygger på", async () => {
    const { item } = await createChain("c");
    await expect(db.sourceItem.delete({ where: { id: item.id } })).rejects.toThrow();
  });

  it("sletter artikkel og endringslogg når saken slettes", async () => {
    const { story, article } = await createChain("d");
    await db.revisionSource.deleteMany({ where: { revision: { articleId: article.id } } });
    await db.story.delete({ where: { id: story.id } });

    expect(await db.article.findUnique({ where: { id: article.id } })).toBeNull();
    expect(await db.articleRevision.count({ where: { articleId: article.id } })).toBe(0);
  });
});
