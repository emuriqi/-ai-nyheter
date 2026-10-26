import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getReviewQueue, pageNumber, REVIEW_PAGE_SIZE } from "@/lib/admin";
import type { Db } from "@/lib/db";
import { createTestDb } from "./helpers/test-db";

const testDb = vi.hoisted(() => ({ current: null as Db | null }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => testDb.current,
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: vi.fn(async () => undefined) }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: vi.fn(async () => undefined),
}));

/** Godkjenningssiden: alle publiserte artikler skal kunne nås, så de kan avpubliseres. */
describe("getReviewQueue", () => {
  let cleanup: () => Promise<void>;
  const total = REVIEW_PAGE_SIZE + 5;

  beforeAll(async () => {
    let db: Db;
    ({ db, cleanup } = createTestDb());
    testDb.current = db;
    for (let i = 0; i < total; i++) {
      const story = await db.story.create({ data: { slug: `sak-${i}`, workingTitle: `Sak ${i}` } });
      await db.article.create({
        data: {
          storyId: story.id,
          title: `Artikkel ${i}`,
          lede: "L",
          body: "B",
          model: "m",
          promptVersion: "p",
          status: "PUBLISHED",
          publishedAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
        },
      });
    }
  });

  afterAll(() => cleanup());

  it("viser publiserte artikler side for side, så også de eldste kan avpubliseres", async () => {
    const first = await getReviewQueue();
    expect(first.published).toHaveLength(REVIEW_PAGE_SIZE);
    expect(first.published[0].title).toBe(`Artikkel ${total - 1}`);
    expect(first.pages.published).toEqual({ page: 1, more: true, total });

    const second = await getReviewQueue({ publishedPage: 2 });
    expect(second.published.map((a) => a.title)).toEqual([
      "Artikkel 4",
      "Artikkel 3",
      "Artikkel 2",
      "Artikkel 1",
      "Artikkel 0",
    ]);
    expect(second.pages.published).toEqual({ page: 2, more: false, total });
  });

  it("viser siste side når sidetallet er for høyt", async () => {
    const queue = await getReviewQueue({ publishedPage: 99, rejectedPage: 5 });
    expect(queue.pages.published).toEqual({ page: 2, more: false, total });
    expect(queue.published).toHaveLength(5);
    expect(queue.pages.rejected).toEqual({ page: 1, more: false, total: 0 });
  });

  it("leser sidetallet fra adressen og faller tilbake til første side", () => {
    expect(pageNumber("2")).toBe(2);
    for (const value of [undefined, "", "0", "-1", "1.5", "abc", "99999", ["2"]]) expect(pageNumber(value)).toBe(1);
  });
});
