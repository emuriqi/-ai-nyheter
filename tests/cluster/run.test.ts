import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoryJudge } from "@/lib/cluster/assign";
import { itemTime, type JudgeSetup, resolveJudge, runClusterJob } from "@/lib/cluster/run";
import { slugify } from "@/lib/cluster/slug";
import { describeCluster } from "@/lib/cluster/summary";
import type { Db } from "@/lib/db";
import { loadCorpus, pairwiseScores } from "../helpers/cluster-corpus";
import { CORPUS_SOURCES, clusterConfig, insertCorpusItem, insertItem, sourceIds } from "../helpers/cluster-db";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-10-12T10:00:00Z");
const corpus = loadCorpus();
const truth = new Map(corpus.map((item) => [item.id, item.event]));

// Et par som havner i gråsonen: samme regnvær i Agder, ulike kilder og ord.
const REGN = {
  guid: "regn",
  title: "Gult farevarsel for kraftig regn i Agder",
  excerpt: "Opptil 90 mm torsdag.",
  publishedAt: new Date("2026-10-07T10:00:00Z"),
};
const SANDSEKKER = {
  guid: "sandsekker",
  title: "Sandsekker til utdeling i Kristiansand",
  excerpt: "NVE varsler flom i Agder torsdag etter mye regn.",
  publishedAt: new Date("2026-10-07T14:00:00Z"),
};

function judgeSetup(judge: StoryJudge, promptVersion = "test@1"): JudgeSetup {
  return { judge, usage: { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 }, promptVersion };
}

describe("runClusterJob", () => {
  let db: Db;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
  });

  afterEach(() => cleanup());

  async function predicted() {
    const items = await db.sourceItem.findMany({ select: { guid: true, storyId: true } });
    return new Map(items.map((item) => [item.guid, item.storyId ?? `ingen-${item.guid}`]));
  }

  const run = (config = clusterConfig(), judge: JudgeSetup | null = null) =>
    runClusterJob(db, { config, trigger: "test", now: NOW, judge });

  it("grupperer korpuset, lagrer hvordan, og logger jobben", async () => {
    const config = clusterConfig({}, CORPUS_SOURCES);
    const ids = await sourceIds(db, config);
    for (const item of corpus) await insertCorpusItem(db, ids, item);

    const result = await run(config);
    if (result.status !== "done") throw new Error("forventet kjøring");

    const items = await db.sourceItem.findMany({ include: { story: true } });
    expect(items.every((item) => item.storyId !== null && item.clusteredAt?.getTime() === NOW.getTime())).toBe(true);
    expect(pairwiseScores(truth, await predicted()).precision).toBe(1);

    const stories = await db.story.findMany({ include: { items: true } });
    expect(result.stats).toMatchObject({ considered: 48, newStories: stories.length, joinedByClaude: 0, claude: null });
    expect(result.stats.joined).toBe(48 - stories.length);
    expect(new Set(stories.map((s) => s.slug)).size).toBe(stories.length);
    for (const story of stories) {
      const times = story.items.map(itemTime);
      expect(story.firstSeenAt.getTime()).toBe(Math.min(...times));
      expect(story.lastSourceAt.getTime()).toBe(Math.max(...times));
    }

    // Den første kilden i en sak gir arbeidstittel og slug.
    const flom = items.find((item) => item.guid === "varsel-03")!;
    expect(flom.story?.workingTitle).toBe("Gult farevarsel – kraftig regn i Agder");
    expect(flom.story?.slug).toBe("gult-farevarsel-kraftig-regn-i-agder");

    // Usikre: ny sak selv om likheten var i gråsonen. De peker på saken de lignet mest på.
    const uncertain = items.filter(
      (item) => item.clusterMethod === "NEW" && (item.clusterScore ?? 0) >= config.clustering.borderlineThreshold,
    );
    expect(uncertain.length).toBe(result.stats.uncertain);
    expect(uncertain.length).toBeGreaterThan(0);
    expect(uncertain.every((item) => item.clusterNearestStoryId !== null)).toBe(true);
    expect(items.filter((i) => i.clusterMethod === "AUTO").every((i) => i.clusterNearestStoryId === null)).toBe(true);

    const job = await db.jobRun.findUniqueOrThrow({ where: { id: result.jobId } });
    expect(job).toMatchObject({ type: "CLUSTER", status: "SUCCEEDED", trigger: "test" });
    expect(job.stats).toMatchObject({ considered: 48 });

    const again = await run(config);
    expect(again.status === "done" && again.stats.considered).toBe(0);
    expect(describeCluster(again)).toBe("Gruppering: ingen nye elementer.");
  });

  it("legger nye elementer til saker fra tidligere kjøringer", async () => {
    const config = clusterConfig({}, CORPUS_SOURCES);
    const ids = await sourceIds(db, config);
    const cut = "2026-10-07T00:00:00Z";
    for (const item of corpus.filter((i) => i.publishedAt < cut)) await insertCorpusItem(db, ids, item);
    await run(config);
    const firstStories = new Set((await db.story.findMany({ select: { id: true } })).map((s) => s.id));

    for (const item of corpus.filter((i) => i.publishedAt >= cut)) await insertCorpusItem(db, ids, item);
    const second = await run(config);
    if (second.status !== "done") throw new Error("forventet kjøring");

    const late = await db.sourceItem.findMany({ where: { publishedAt: { gte: new Date(cut) } } });
    expect(late.some((item) => firstStories.has(item.storyId!))).toBe(true);
    expect(second.stats.joined).toBeGreaterThan(0);
    expect(pairwiseScores(truth, await predicted()).precision).toBe(1);
  });

  it("behandler elementer i publiseringsrekkefølge og utvider saken bakover i tid", async () => {
    const ids = await sourceIds(db, clusterConfig());
    // Hentet i motsatt rekkefølge av publisering.
    await insertItem(db, ids.aktiv, {
      guid: "senere",
      title: "Flom i Agder: Otra går over sine bredder",
      publishedAt: new Date("2026-10-08T12:00:00Z"),
      fetchedAt: new Date("2026-10-08T12:05:00Z"),
    });
    await insertItem(db, ids.aktiv2, {
      guid: "tidligere",
      title: "Flom i Agder: Otra går over sine bredder",
      publishedAt: new Date("2026-10-08T08:00:00Z"),
      fetchedAt: new Date("2026-10-08T13:00:00Z"),
    });
    await run();
    const tidligere = await db.sourceItem.findFirstOrThrow({ where: { guid: "tidligere" } });
    const senere = await db.sourceItem.findFirstOrThrow({ where: { guid: "senere" } });
    expect(tidligere.clusterMethod).toBe("NEW");
    expect(senere).toMatchObject({ clusterMethod: "AUTO", storyId: tidligere.storyId });

    // En kilde publisert før sakens første kilde, i en senere kjøring.
    await insertItem(db, ids.aktiv, {
      guid: "tidligst",
      title: "Flom i Agder: Otra går over sine bredder",
      publishedAt: new Date("2026-10-07T20:00:00Z"),
      fetchedAt: new Date("2026-10-08T14:00:00Z"),
    });
    await run();
    const story = await db.story.findUniqueOrThrow({ where: { id: tidligere.storyId! }, include: { items: true } });
    expect(story.items).toHaveLength(3);
    expect(story.firstSeenAt).toEqual(new Date("2026-10-07T20:00:00Z"));
  });

  describe("hva som analyseres", () => {
    it("grupperer ikke reserverte, slettede eller pausede elementer", async () => {
      const ids = await sourceIds(db, clusterConfig());
      const publishedAt = new Date("2026-10-10T08:00:00Z");
      await insertItem(db, ids.aktiv, { guid: "ok", title: "Flom i Agder", excerpt: "Mye regn.", publishedAt });
      await insertItem(db, ids.aktiv, { guid: "tdm", title: "Flom i Agder", publishedAt, tdmReserved: true });
      await insertItem(db, ids.aktiv, { guid: "slettet", title: "Flom i Agder", publishedAt, purgedAt: NOW });
      await insertItem(db, ids.pause, { guid: "pause", title: "Flom i Agder", excerpt: "Mye regn.", publishedAt });

      await run();

      const items = await db.sourceItem.findMany({ select: { guid: true, storyId: true } });
      expect(Object.fromEntries(items.map((i) => [i.guid, i.storyId !== null]))).toEqual({
        ok: true,
        tdm: false,
        slettet: false,
        pause: false,
      });
    });

    it("grupperer ikke elementer fra en kilde der det senere er funnet TDM-reservasjon", async () => {
      const ids = await sourceIds(db, clusterConfig());
      await db.source.update({ where: { id: ids.aktiv2 }, data: { tdmReservationFound: true } });
      await insertItem(db, ids.aktiv2, { ...REGN });
      await run();
      expect((await db.sourceItem.findFirstOrThrow({ where: { guid: "regn" } })).storyId).toBeNull();
    });

    it.each([
      [
        "kilden er satt på pause",
        async (db: Db, ids: Record<string, string>, id: string) => {
          await db.sourceItem.update({ where: { id }, data: { sourceId: ids.pause } });
        },
      ],
      [
        "elementet er reservert mot TDM",
        async (db: Db, _ids: Record<string, string>, id: string) => {
          await db.sourceItem.update({ where: { id }, data: { tdmReserved: true } });
        },
      ],
      [
        "kilden har TDM-reservasjon",
        async (db: Db, ids: Record<string, string>) => {
          await db.source.update({ where: { id: ids.aktiv }, data: { tdmReservationFound: true } });
        },
      ],
      [
        "teksten er slettet",
        async (db: Db, _ids: Record<string, string>, id: string) => {
          await db.sourceItem.update({ where: { id }, data: { purgedAt: NOW, excerpt: null } });
        },
      ],
    ])("sender ikke et element i en åpen sak til Claude når %s", async (_name, change) => {
      const ids = await sourceIds(db, clusterConfig());
      const regn = await insertItem(db, ids.aktiv, { ...REGN });
      await run();
      await change(db, ids, regn.id);

      await insertItem(db, ids.aktiv2, { ...SANDSEKKER });
      const judge = vi.fn<StoryJudge>(async () => ({ match: "A", reason: "" }));
      await run(clusterConfig(), judgeSetup(judge));

      // Saken har ingen elementer som kan vises, så den er ikke kandidat.
      expect(judge).not.toHaveBeenCalled();
      const sandsekker = await db.sourceItem.findFirstOrThrow({ where: { guid: "sandsekker" } });
      expect(sandsekker).toMatchObject({ clusterMethod: "NEW", clusterScore: null });
    });

    it("lar ikke tekst som ikke kan analyseres påvirke ordvektene", async () => {
      const ids = await sourceIds(db, clusterConfig());
      await insertItem(db, ids.aktiv, { ...REGN });
      await insertItem(db, ids.aktiv2, { ...SANDSEKKER });
      await run();
      const before = (await db.sourceItem.findFirstOrThrow({ where: { guid: "sandsekker" } })).clusterScore;

      const { db: other, cleanup: cleanupOther } = createTestDb();
      try {
        const otherIds = await sourceIds(other, clusterConfig());
        await insertItem(other, otherIds.aktiv, { ...REGN });
        await insertItem(other, otherIds.aktiv2, { ...SANDSEKKER });
        // Mange reserverte og pausede elementer med de samme ordene.
        for (let i = 0; i < 20; i++) {
          const text = {
            title: "Gult farevarsel for kraftig regn i Agder",
            excerpt: "Flom i Agder.",
            publishedAt: REGN.publishedAt,
          };
          await insertItem(other, otherIds.aktiv, { ...text, guid: `tdm-${i}`, tdmReserved: true });
          await insertItem(other, otherIds.pause, { ...text, guid: `pause-${i}` });
        }
        await runClusterJob(other, { config: clusterConfig(), trigger: "test", now: NOW, judge: null });
        const after = (await other.sourceItem.findFirstOrThrow({ where: { guid: "sandsekker" } })).clusterScore;
        expect(after).toBeCloseTo(before!, 10);
      } finally {
        await cleanupOther();
      }
    });
  });

  it("lar Claude avgjøre gråsonen og lagrer begrunnelsen og bruken", async () => {
    const ids = await sourceIds(db, clusterConfig());
    await insertItem(db, ids.aktiv, { ...REGN });
    await insertItem(db, ids.aktiv2, { ...SANDSEKKER });
    const judge = vi.fn<StoryJudge>(async () => ({ match: "A", reason: "Samme regnvær i Agder." }));
    const setup = judgeSetup(judge);
    setup.usage.calls = 1;

    const result = await run(clusterConfig(), setup);

    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][1]).toEqual([
      { key: "A", items: [{ title: REGN.title, excerpt: REGN.excerpt, bodyText: null }] },
    ]);
    const regn = await db.sourceItem.findFirstOrThrow({ where: { guid: "regn" } });
    const sandsekker = await db.sourceItem.findFirstOrThrow({ where: { guid: "sandsekker" } });
    expect(sandsekker).toMatchObject({
      storyId: regn.storyId,
      clusterMethod: "CLAUDE",
      clusterNote: "Samme regnvær i Agder.",
    });
    expect(result.status === "done" && result.stats).toMatchObject({
      joinedByClaude: 1,
      claude: setup.usage,
      promptVersion: "test@1",
    });
    expect(describeCluster(result)).toBe(
      "Gruppering: 2 elementer, 1 ny sak, 1 lagt til eksisterende saker, Claude vurderte 1 (1 samme sak, 0 ny sak).",
    );
  });

  describe("endringer fra andre underveis", () => {
    it("hopper over et element som en annen prosess grupperte først", async () => {
      const ids = await sourceIds(db, clusterConfig());
      await insertItem(db, ids.aktiv, { ...REGN });
      await run();
      const other = await db.story.create({ data: { slug: "annen-prosess", workingTitle: "Annen prosess" } });
      const sandsekker = await insertItem(db, ids.aktiv2, { ...SANDSEKKER });
      const judge = vi.fn<StoryJudge>(async () => {
        await db.sourceItem.updateMany({ where: { id: sandsekker.id }, data: { storyId: other.id } });
        return { match: null, reason: "" };
      });

      const result = await run(clusterConfig(), judgeSetup(judge));

      expect(result.status === "done" && result.stats).toMatchObject({ considered: 0, skipped: 1, newByClaude: 0 });
      expect(await db.story.count()).toBe(2);
      expect((await db.sourceItem.findUniqueOrThrow({ where: { id: sandsekker.id } })).storyId).toBe(other.id);
      expect(describeCluster(result)).toBe(
        "Gruppering: 0 elementer, 0 nye saker, 0 lagt til eksisterende saker, 1 endret underveis og tas i neste kjøring.",
      );
    });

    it("hopper over et element når saken det skulle til, er slettet underveis, og tar det i neste kjøring", async () => {
      const ids = await sourceIds(db, clusterConfig());
      const regn = await insertItem(db, ids.aktiv, { ...REGN });
      await run();
      const original = (await db.sourceItem.findUniqueOrThrow({ where: { id: regn.id } })).storyId!;
      const moved = await db.story.create({ data: { slug: "flyttet", workingTitle: "Flyttet" } });

      // Samme kilde og tekst: alltid gråsone, så dommeren kalles midt i kjøringen.
      await insertItem(db, ids.aktiv, { ...REGN, guid: "oppdatering", publishedAt: new Date("2026-10-07T12:00:00Z") });
      // Samme tekst fra en annen kilde: slås sammen automatisk med saken i minnet.
      const kopi = await insertItem(db, ids.aktiv2, {
        ...REGN,
        guid: "kopi",
        publishedAt: new Date("2026-10-07T15:00:00Z"),
      });
      const judge = vi.fn<StoryJudge>(async () => {
        // En redaktør flytter det eneste elementet ut, og saken slettes.
        await db.sourceItem.update({ where: { id: regn.id }, data: { storyId: moved.id } });
        await db.story.delete({ where: { id: original } });
        return { match: null, reason: "" };
      });

      const result = await run(clusterConfig(), judgeSetup(judge));
      if (result.status !== "done") throw new Error("forventet kjøring");
      expect(judge).toHaveBeenCalledTimes(1);
      expect(result.stats).toMatchObject({ skipped: 1, newByClaude: 1 });
      expect((await db.sourceItem.findUniqueOrThrow({ where: { id: kopi.id } })).storyId).toBeNull();
      expect((await db.jobRun.findUniqueOrThrow({ where: { id: result.jobId } })).status).toBe("SUCCEEDED");

      await run();
      expect((await db.sourceItem.findUniqueOrThrow({ where: { id: kopi.id } })).storyId).not.toBeNull();
    });
  });

  it("stopper ikke når de nummererte slugene for en tittel er brukt opp", async () => {
    const ids = await sourceIds(db, clusterConfig());
    const base = slugify(REGN.title);
    const old = new Date("2025-01-01T00:00:00Z");
    for (const slug of [base, ...Array.from({ length: 19 }, (_, i) => `${base}-${i + 2}`)]) {
      await db.story.create({ data: { slug, workingTitle: REGN.title, firstSeenAt: old, lastSourceAt: old } });
    }
    await insertItem(db, ids.aktiv, { ...REGN });
    const result = await run();
    expect(result.status).toBe("done");
    const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "regn" }, include: { story: true } });
    expect(item.story?.slug).toMatch(new RegExp(`^${base}-[0-9a-f]{6}$`));
  });

  it("hopper over når en gruppering allerede kjører", async () => {
    await db.jobRun.create({ data: { type: "CLUSTER", trigger: "cron", startedAt: new Date(NOW.getTime() - 60_000) } });
    expect(await run()).toEqual({ status: "skipped", reason: "En gruppering kjører allerede" });
  });

  it("bruker hentetiden når publiseringstiden mangler eller ligger etter den", () => {
    const fetchedAt = new Date("2026-10-10T10:00:00Z");
    expect(itemTime({ publishedAt: null, fetchedAt })).toBe(fetchedAt.getTime());
    expect(itemTime({ publishedAt: new Date("2030-01-01T00:00:00Z"), fetchedAt })).toBe(fetchedAt.getTime());
    expect(itemTime({ publishedAt: new Date("2026-10-09T10:00:00Z"), fetchedAt })).toBe(
      new Date("2026-10-09T10:00:00Z").getTime(),
    );
  });
});

describe("resolveJudge", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("bruker ikke Claude uten nøkkel eller når det er slått av", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(resolveJudge(clusterConfig({ useClaudeForBorderline: true }), undefined)).toBeNull();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(resolveJudge(clusterConfig({ useClaudeForBorderline: false }), undefined)).toBeNull();
    expect(
      resolveJudge(clusterConfig({ useClaudeForBorderline: true, maxClaudeChecksPerRun: 0 }), undefined),
    ).toBeNull();
  });

  it("lager en Claude-dommer når nøkkelen finnes og det er slått på", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const setup = resolveJudge(clusterConfig({ useClaudeForBorderline: true }), undefined);
    expect(setup?.promptVersion).toMatch(/^cluster-same-story@/);
    expect(setup?.usage.calls).toBe(0);
  });

  it("bruker den oppgitte dommeren, også null", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(resolveJudge(clusterConfig({ useClaudeForBorderline: true }), null)).toBeNull();
  });
});
