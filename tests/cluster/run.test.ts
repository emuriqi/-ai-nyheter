import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoryJudge } from "@/lib/cluster/assign";
import { itemTime, resolveJudge, runClusterJob } from "@/lib/cluster/run";
import { describeCluster } from "@/lib/cluster/summary";
import type { Db } from "@/lib/db";
import { loadCorpus, pairwiseScores } from "../helpers/cluster-corpus";
import { clusterConfig, insertCorpusItem, insertItem, sourceIds } from "../helpers/cluster-db";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-10-12T10:00:00Z");
const corpus = loadCorpus();
const truth = new Map(corpus.map((item) => [item.id, item.event]));

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

  it("grupperer korpuset, lagrer hvordan, og logger jobben", async () => {
    const config = clusterConfig();
    const { aktiv } = await sourceIds(db, config);
    for (const item of corpus) await insertCorpusItem(db, aktiv, item);

    const result = await runClusterJob(db, { config, trigger: "test", now: NOW, judge: null });
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

    const again = await runClusterJob(db, { config, trigger: "test", now: NOW, judge: null });
    expect(again.status === "done" && again.stats.considered).toBe(0);
    expect(describeCluster(again)).toBe("Gruppering: ingen nye elementer.");
  });

  it("legger nye elementer til saker fra tidligere kjøringer", async () => {
    const config = clusterConfig();
    const { aktiv } = await sourceIds(db, config);
    const cut = "2026-10-07T00:00:00Z";
    for (const item of corpus.filter((i) => i.publishedAt < cut)) await insertCorpusItem(db, aktiv, item);
    await runClusterJob(db, { config, trigger: "test", now: NOW, judge: null });
    const firstStories = new Set((await db.story.findMany({ select: { id: true } })).map((s) => s.id));

    for (const item of corpus.filter((i) => i.publishedAt >= cut)) await insertCorpusItem(db, aktiv, item);
    const second = await runClusterJob(db, { config, trigger: "test", now: NOW, judge: null });
    if (second.status !== "done") throw new Error("forventet kjøring");

    const late = await db.sourceItem.findMany({ where: { publishedAt: { gte: new Date(cut) } } });
    expect(late.some((item) => firstStories.has(item.storyId!))).toBe(true);
    expect(second.stats.joined).toBeGreaterThan(0);
    expect(pairwiseScores(truth, await predicted()).precision).toBe(1);
  });

  it("grupperer ikke reserverte, slettede eller pausede elementer", async () => {
    const config = clusterConfig();
    const ids = await sourceIds(db, config);
    const publishedAt = new Date("2026-10-10T08:00:00Z");
    await insertItem(db, ids.aktiv, { guid: "ok", title: "Flom i Agder", excerpt: "Mye regn.", publishedAt });
    await insertItem(db, ids.aktiv, { guid: "tdm", title: "Flom i Agder", publishedAt, tdmReserved: true });
    await insertItem(db, ids.aktiv, { guid: "slettet", title: "Flom i Agder", publishedAt, purgedAt: NOW });
    await insertItem(db, ids.pause, { guid: "pause", title: "Flom i Agder", excerpt: "Mye regn.", publishedAt });

    await runClusterJob(db, { config, trigger: "test", now: NOW, judge: null });

    const items = await db.sourceItem.findMany({ select: { guid: true, storyId: true } });
    expect(Object.fromEntries(items.map((i) => [i.guid, i.storyId !== null]))).toEqual({
      ok: true,
      tdm: false,
      slettet: false,
      pause: false,
    });
  });

  it("lar Claude avgjøre gråsonen og lagrer begrunnelsen og bruken", async () => {
    const config = clusterConfig();
    const { aktiv } = await sourceIds(db, config);
    await insertItem(db, aktiv, {
      guid: "a",
      title: "Gult farevarsel for kraftig regn i Agder",
      excerpt: "Opptil 90 mm torsdag.",
      publishedAt: new Date("2026-10-07T10:00:00Z"),
    });
    await insertItem(db, aktiv, {
      guid: "b",
      title: "Sandsekker til utdeling i Kristiansand",
      excerpt: "NVE varsler flom i Agder torsdag etter mye regn.",
      publishedAt: new Date("2026-10-07T14:00:00Z"),
    });
    const judge = vi.fn<StoryJudge>(async () => ({ match: "A", reason: "Samme regnvær i Agder." }));
    const usage = { calls: 1, failures: 0, inputTokens: 10, outputTokens: 2 };

    const result = await runClusterJob(db, {
      config,
      trigger: "test",
      now: NOW,
      judge: { judge, usage, promptVersion: "test@1" },
    });

    expect(judge).toHaveBeenCalledTimes(1);
    const b = await db.sourceItem.findFirstOrThrow({ where: { guid: "b" } });
    const a = await db.sourceItem.findFirstOrThrow({ where: { guid: "a" } });
    expect(b).toMatchObject({ storyId: a.storyId, clusterMethod: "CLAUDE", clusterNote: "Samme regnvær i Agder." });
    expect(result.status === "done" && result.stats).toMatchObject({
      joinedByClaude: 1,
      claude: usage,
      promptVersion: "test@1",
    });
    expect(describeCluster(result)).toBe(
      "Gruppering: 2 elementer, 1 ny sak, 1 lagt til eksisterende saker, Claude vurderte 1 (1 samme sak, 0 ny sak).",
    );
  });

  it("hopper over når en gruppering allerede kjører", async () => {
    const config = clusterConfig();
    await db.jobRun.create({ data: { type: "CLUSTER", trigger: "cron", startedAt: new Date(NOW.getTime() - 60_000) } });
    expect(await runClusterJob(db, { config, trigger: "test", now: NOW, judge: null })).toEqual({
      status: "skipped",
      reason: "En gruppering kjører allerede",
    });
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
    expect(resolveJudge(clusterConfig(), undefined)).toBeNull();
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
