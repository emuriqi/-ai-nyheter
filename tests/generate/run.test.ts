import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyUsage } from "@/lib/ai/claude";
import type { SiteConfig } from "@/lib/config/schema";
import type { Db } from "@/lib/db";
import type { ArticleWriter, ModerateOutcome, WriteOutcome } from "@/lib/generate/claude";
import { findCandidates, type GenerateAgents, resolveAgents, runGenerateJob } from "@/lib/generate/run";
import { pipelineFailed } from "@/lib/ingest/pipeline";
import { describeGenerate } from "@/lib/generate/summary";
import type { WrittenArticle } from "@/lib/generate/schema";
import { loadCorpus } from "../helpers/cluster-corpus";
import { CORPUS_SOURCES, clusterConfig, insertCorpusItem, sourceIds } from "../helpers/cluster-db";
import { loadGeneratedArticles } from "../helpers/generated-articles";
import { createTestDb } from "../helpers/test-db";

const NOW = new Date("2026-10-08T12:00:00Z");
const regn = loadGeneratedArticles().find((s) => s.event === "regn-agder")!;
const corpus = loadCorpus();

function config(overrides: Partial<SiteConfig["generation"]> = {}, editorial: Partial<SiteConfig["editorial"]> = {}) {
  const base = clusterConfig({}, CORPUS_SOURCES);
  return {
    ...base,
    editorial: { ...base.editorial, ...editorial },
    generation: { ...base.generation, enabled: true, ...overrides },
  };
}

function agents(
  write: (sources: Parameters<ArticleWriter["write"]>[0]) => Promise<WriteOutcome>,
  moderate: () => Promise<ModerateOutcome> = async () => ({
    ok: true,
    result: { vurdering: "ok", funn: [], sensitive_temaer: [] },
  }),
): GenerateAgents {
  return {
    writer: { write: vi.fn(write), usage: emptyUsage(), promptVersion: "article-write@test", model: "claude-test" },
    moderator: {
      moderate: vi.fn(moderate),
      usage: emptyUsage(),
      promptVersion: "article-moderate@test",
      model: "claude-test",
    },
  };
}

const writes = (article: WrittenArticle) => async (): Promise<WriteOutcome> => ({ ok: true, article });

describe("runGenerateJob", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  let storyId: string;

  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    const ids = await sourceIds(db, config());
    // Saken om regnet i Agder, med de fire kildene fra korpuset.
    const story = await db.story.create({
      data: {
        slug: "flom-i-agder",
        workingTitle: "Flom i Agder",
        firstSeenAt: new Date("2026-10-07T10:14:00Z"),
        lastSourceAt: new Date("2026-10-07T15:18:00Z"),
      },
    });
    storyId = story.id;
    for (const item of corpus.filter((i) => i.event === "regn-agder")) {
      const created = await insertCorpusItem(db, ids, item);
      await db.sourceItem.update({ where: { id: created.id }, data: { storyId } });
    }
  });

  afterEach(() => cleanup());

  /** En sak til, med elementene fra en annen hendelse i korpuset. Returnerer id-en. */
  async function addStory(event: string): Promise<string> {
    const ids = await sourceIds(db, config());
    const story = await db.story.create({
      data: {
        slug: event,
        workingTitle: event,
        firstSeenAt: new Date("2026-10-07T00:00:00Z"),
        lastSourceAt: new Date("2026-10-07T01:00:00Z"),
      },
    });
    for (const item of corpus.filter((i) => i.event === event)) {
      const created = await insertCorpusItem(db, ids, item);
      await db.sourceItem.update({ where: { id: created.id }, data: { storyId: story.id } });
    }
    return story.id;
  }

  const run = (cfg: SiteConfig, a: GenerateAgents | null) =>
    runGenerateJob(db, { config: cfg, trigger: "test", now: NOW, agents: a });

  it("skriver, kontrollerer og lagrer en artikkel til godkjenning", async () => {
    const a = agents(writes(regn.good));
    const result = await run(config(), a);
    if (result.status !== "done") throw new Error("forventet kjøring");

    // Skriveren fikk kildene i tidsrekkefølge, med teksten fra korpuset.
    const sources = vi.mocked(a.writer.write).mock.calls[0][0];
    expect(sources.map((s) => s.key)).toEqual(["K1", "K2", "K3", "K4"]);
    expect(sources.map((s) => s.text)).toEqual(regn.sources.map((s) => s.text));

    const article = await db.article.findUniqueOrThrow({
      where: { storyId },
      include: { revisions: { include: { sources: true, moderation: true } }, story: true },
    });
    expect(article).toMatchObject({
      title: regn.good.tittel,
      lede: regn.good.ingress,
      body: regn.good.brodtekst,
      version: 1,
      status: "PENDING_REVIEW",
      aiGenerated: true,
      model: "claude-test",
      promptVersion: "article-write@test+article-moderate@test",
      publishedAt: null,
    });
    const [revision] = article.revisions;
    expect(revision).toMatchObject({ version: 1, type: "CREATED", createdBy: "AI", changeSummary: "Første versjon" });
    expect(revision.reason).toBe("Ny sak fra 4 kilder");
    expect(revision.sources).toHaveLength(4);
    expect(revision.moderation).toMatchObject({
      verdict: "FLAGGED",
      decision: "PENDING",
      checkedBy: "AI",
      model: "claude-test",
    });
    // Skriverens merknader om usikkerhet følger med til redaktøren og flagger artikkelen.
    expect(revision.moderation!.reasons).toEqual(
      regn.good.usikkerhet.map((message) => ({ origin: "skriver", kind: "usikkerhet", severity: "middels", message })),
    );
    expect(article.story).toMatchObject({ category: "vær og klima", sensitivity: "NORMAL", lastGenerationError: null });

    expect(result.stats).toMatchObject({
      considered: 1,
      pendingReview: 1,
      published: 0,
      flagged: 1,
      blocked: 0,
      failed: 0,
      stopped: null,
    });
    expect(describeGenerate(result)).toBe("Skriving: 1 ny artikkel, 1 venter på godkjenning, 1 flagget.");
    const job = await db.jobRun.findUniqueOrThrow({ where: { id: result.jobId } });
    expect(job).toMatchObject({ type: "GENERATE", status: "SUCCEEDED" });

    // Saken har nå en artikkel og skrives ikke på nytt.
    const again = await run(config(), agents(writes(regn.good)));
    expect(again.status === "done" && again.stats.considered).toBe(0);
  });

  it("publiserer uten manuell godkjenning bare med FLAGGED_ONLY og ingen funn", async () => {
    const good = { ...regn.good, usikkerhet: [] };
    await run(config({}, { manualApproval: "FLAGGED_ONLY" }), agents(writes(good)));
    const article = await db.article.findUniqueOrThrow({
      where: { storyId },
      include: { revisions: { include: { moderation: true } } },
    });
    expect(article).toMatchObject({ status: "PUBLISHED", publishedAt: NOW });
    expect(article.revisions[0].moderation).toMatchObject({ decision: "APPROVED", decidedAt: NOW });
  });

  it("lagrer brudd på faste regler og funn fra modereringen for redaktøren", async () => {
    const copied = regn.variants.find((v) => v.feil === "kopiert_tekst")!.artikkel;
    const result = await run(
      config({}, { manualApproval: "FLAGGED_ONLY" }),
      agents(writes(copied), async () => ({
        ok: true,
        result: {
          vurdering: "flagget",
          funn: [{ type: "kopiert_tekst", alvor: "høy", utdrag: "NVE har sendt ut", forklaring: "Kopiert fra K2." }],
          sensitive_temaer: [],
        },
      })),
    );
    const moderation = await db.moderationReview.findFirstOrThrow();
    expect(moderation).toMatchObject({ verdict: "FLAGGED", decision: "PENDING" });
    const reasons = moderation.reasons as { origin: string; kind: string; severity: string }[];
    expect(reasons.slice(0, 2).map((r) => [r.origin, r.kind, r.severity])).toEqual([
      ["kontroll", "kopiert_tekst", "blokkerer"],
      ["moderering", "kopiert_tekst", "høy"],
    ]);
    expect(await db.article.findFirstOrThrow()).toMatchObject({ status: "PENDING_REVIEW" });
    expect(result.status === "done" && result.stats).toMatchObject({ pendingReview: 1, flagged: 1, blocked: 1 });
  });

  it("markerer sensitive saker", async () => {
    await run(config(), agents(writes({ ...regn.good, sensitive_temaer: ["ulykker"] })));
    expect(await db.story.findUniqueOrThrow({ where: { id: storyId } })).toMatchObject({
      sensitivity: "SENSITIVE",
      sensitivityReasons: ["ulykker"],
    });
  });

  it("flagger og merker kontrollen som automatisk når modereringen feiler", async () => {
    await run(
      config(),
      agents(writes(regn.good), async () => ({
        ok: false,
        reason: "Moderering uten svar: svaret kunne ikke tolkes",
        stopRun: false,
      })),
    );
    expect(await db.moderationReview.findFirstOrThrow()).toMatchObject({
      verdict: "FLAGGED",
      checkedBy: "SYSTEM",
      model: null,
    });
  });

  it("teller mislykkede forsøk og gir opp etter grensen", async () => {
    const failing = agents(async () => ({
      ok: false,
      reason: "Skriving uten svar: stop_reason refusal",
      stopRun: false,
    }));
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await run(config({ maxAttemptsPerStory: 3 }), failing));
    expect(failing.writer.write).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r.status === "done" && [r.stats.failed, r.stats.gaveUp])).toEqual([
      [1, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]);
    expect(describeGenerate(results[2])).toContain("1 gitt opp etter for mange forsøk");
    expect(describeGenerate(results[0])).toContain("1 feilet og prøves igjen");
    expect(await db.story.findUniqueOrThrow({ where: { id: storyId } })).toMatchObject({
      generationAttempts: 3,
      lastGenerationError: "Skriving uten svar: stop_reason refusal",
    });
    expect(await db.article.count()).toBe(0);
  });

  it("hopper over saken hvis den fikk en artikkel fra en annen prosess underveis", async () => {
    const result = await run(
      config(),
      agents(async () => {
        await db.article.create({
          data: { storyId, title: "Annen", lede: "L", body: "B", model: "m", promptVersion: "p" },
        });
        return { ok: true, article: regn.good };
      }),
    );
    expect(result.status === "done" && result.stats).toMatchObject({ skipped: 1, pendingReview: 0 });
    expect(await db.article.findFirstOrThrow()).toMatchObject({ title: "Annen" });
  });

  it("stopper kjøringen uten å telle forsøk når API-et eller nøkkelen feiler", async () => {
    await addStory("fugl-rogaland");
    const failing = agents(async () => ({
      ok: false,
      reason: "Skriving feilet: AuthenticationError (401)",
      stopRun: true,
    }));
    const result = await run(config(), failing);
    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") throw new Error("forventet stopp");
    expect(result.reason).toBe("Skriving feilet: AuthenticationError (401)");
    // Bare den første saken ble forsøkt, og ingen sak har brukt opp et forsøk.
    expect(failing.writer.write).toHaveBeenCalledTimes(1);
    expect(await db.story.count({ where: { generationAttempts: { gt: 0 } } })).toBe(0);
    expect(await db.jobRun.findUniqueOrThrow({ where: { id: result.jobId } })).toMatchObject({
      status: "FAILED",
      error: "Skriving feilet: AuthenticationError (401)",
    });
    expect(describeGenerate(result)).toContain("Skriving stoppet av en feil hos Claude API");
    // Cron-ruten og skriptet melder feilen.
    expect(pipelineFailed({ cluster: { status: "skipped", reason: "" }, generate: result })).toBe(true);
  });

  it("merker saken som stoppet kjøringen, og tar den sist i neste kjøring", async () => {
    const fugl = await addStory("fugl-rogaland");
    const order: string[] = [];
    const a = agents(async (sources) => {
      const item = await db.sourceItem.findUniqueOrThrow({ where: { id: sources[0].itemId } });
      order.push(item.storyId === storyId ? "regn" : "fugl");
      if (item.storyId === storyId)
        return { ok: false, reason: "Skriving feilet: InternalServerError (529)", stopRun: true };
      return { ok: true, article: regn.good };
    });
    expect((await run(config(), a)).status).toBe("stopped");
    expect(await db.story.findUniqueOrThrow({ where: { id: storyId } })).toMatchObject({
      generationAttempts: 0,
      lastGenerationAt: NOW,
      lastGenerationError: "Skriving feilet: InternalServerError (529)",
    });
    // Neste kjøring tar saken som ikke er forsøkt, først.
    await run(config(), a);
    expect(order).toEqual(["regn", "fugl", "regn"]);
    expect(await db.article.count({ where: { storyId: fugl } })).toBe(1);
  });

  it("lagrer ingenting når modereringen stopper av en feil hos API-et", async () => {
    const result = await run(
      config(),
      agents(writes(regn.good), async () => ({
        ok: false,
        reason: "Moderering feilet: InternalServerError (529)",
        stopRun: true,
      })),
    );
    expect(result.status).toBe("stopped");
    expect(await db.article.count()).toBe(0);
    expect(await db.story.findUniqueOrThrow({ where: { id: storyId } })).toMatchObject({ generationAttempts: 0 });
  });

  it("starter ikke på flere saker etter tidsfristen", async () => {
    await addStory("fugl-rogaland");
    const a = agents(writes(regn.good));
    const result = await runGenerateJob(db, { config: config(), trigger: "test", now: NOW, agents: a, budgetMs: 0 });
    expect(result.status).toBe("done");
    expect(result.status === "done" && result.stats).toMatchObject({
      considered: 1,
      stopped: "tidsfristen for kjøringen er nådd",
    });
    expect(a.writer.write).toHaveBeenCalledTimes(1);
  });

  it("lagrer ikke artikkelen hvis kildene ble flyttet mens den ble skrevet", async () => {
    const other = await addStory("fugl-rogaland");
    const result = await run(
      config(),
      agents(async (sources) => {
        // Redaktøren flytter et element fra saken til en annen sak mens Claude skriver.
        await db.sourceItem.update({ where: { id: sources[0].itemId }, data: { storyId: other } });
        return { ok: true, article: regn.good };
      }),
    );
    expect(result.status === "done" && result.stats).toMatchObject({ changed: 1, pendingReview: 1 });
    // Den andre saken ble skrevet med den flyttede kilden; den første lagres ikke og skrives i neste kjøring.
    expect(await db.article.count({ where: { storyId } })).toBe(0);
    expect(await db.story.findUniqueOrThrow({ where: { id: storyId } })).toMatchObject({ generationAttempts: 0 });
  });

  it("kaster ikke når saken er slettet mens den ble skrevet", async () => {
    const written = await run(
      config(),
      agents(async () => {
        await db.sourceItem.updateMany({ where: { storyId }, data: { storyId: null } });
        await db.story.delete({ where: { id: storyId } });
        return { ok: true, article: regn.good };
      }),
    );
    expect(written.status === "done" && written.stats).toMatchObject({ changed: 1 });
  });

  it("kaster ikke når saken er slettet før en mislykket skriving lagres", async () => {
    const failed = await run(
      config(),
      agents(async () => {
        await db.sourceItem.updateMany({ where: { storyId }, data: { storyId: null } });
        await db.story.delete({ where: { id: storyId } });
        return { ok: false, reason: "Skriving uten svar: stop_reason refusal", stopRun: false };
      }),
    );
    expect(failed.status === "done" && failed.stats).toMatchObject({ failed: 1 });
  });

  it("lagrer alle kildene Claude fikk se, og fjerner kildehenvisninger fra teksten", async () => {
    await run(config(), agents(writes({ ...regn.good, kilder_brukt: ["K1"], ingress: `${regn.good.ingress} [K1]` })));
    const article = await db.article.findUniqueOrThrow({
      where: { storyId },
      include: { revisions: { include: { sources: true, moderation: true } } },
    });
    expect(article.revisions[0].sources).toHaveLength(4);
    expect(article.lede).toBe(regn.good.ingress);
    const reasons = article.revisions[0].moderation!.reasons as { kind: string }[];
    expect(reasons.map((r) => r.kind)).toContain("kildehenvisning_i_teksten");
  });

  it("markerer saken som sensitiv når bare moderatoren melder et sensitivt tema", async () => {
    await run(
      config(),
      agents(writes(regn.good), async () => ({
        ok: true,
        result: {
          vurdering: "ok",
          funn: [{ type: "sensitivt_tema", alvor: "lav", utdrag: "døde", forklaring: "Saken omtaler et dødsfall." }],
          sensitive_temaer: [],
        },
      })),
    );
    expect(await db.story.findUniqueOrThrow({ where: { id: storyId } })).toMatchObject({
      sensitivity: "SENSITIVE",
      sensitivityReasons: ["sensitivt tema"],
    });
  });

  it("skriver ikke mens en annen skriving kjører", async () => {
    await db.jobRun.create({
      data: { type: "GENERATE", trigger: "cron", startedAt: new Date(NOW.getTime() - 60_000) },
    });
    const a = agents(writes(regn.good));
    expect(await run(config(), a)).toEqual({ status: "skipped", reason: "En skriving kjører allerede" });
    expect(a.writer.write).not.toHaveBeenCalled();
  });

  it("kjører bare én skriving om gangen i samme prosess", async () => {
    let release: () => void = () => {};
    const slow = agents(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { ok: true, article: regn.good };
    });
    const first = run(config(), slow);
    await vi.waitFor(() => expect(slow.writer.write).toHaveBeenCalled());
    const second = agents(writes(regn.good));
    expect(await run(config(), second)).toEqual({ status: "skipped", reason: "En skriving kjører allerede" });
    release();
    expect((await first).status).toBe("done");
    expect(second.writer.write).not.toHaveBeenCalled();
  });

  describe("hvilke saker som er klare", () => {
    it.each([
      ["saken har fått en kilde nylig", { settleMinutes: 30 }, new Date("2026-10-07T15:30:00Z"), 0],
      ["saken er for gammel", { maxStoryAgeHours: 12 }, NOW, 0],
      ["saken har for få kilder", { minSourcesPerStory: 5 }, NOW, 0],
      ["grensen per kjøring er 0", { maxArticlesPerRun: 0 }, NOW, 0],
      ["saken er klar", {}, NOW, 1],
    ])("%s", async (_name, overrides, now, expected) => {
      expect(await findCandidates(db, config(overrides), now)).toHaveLength(expected);
    });

    it("venter også når en gammel kilde nettopp er lagt i saken", async () => {
      // Kilden er publisert lenge før, men hentet og gruppert for ti minutter siden.
      await db.sourceItem.updateMany({
        where: { storyId, guid: "byraa-02" },
        data: { clusteredAt: new Date(NOW.getTime() - 10 * 60_000) },
      });
      expect(await findCandidates(db, config({ settleMinutes: 30 }), NOW)).toHaveLength(0);
      expect(await findCandidates(db, config({ settleMinutes: 5 }), NOW)).toHaveLength(1);
    });

    it("sender ikke tekst som utløper før skrivingen og modereringen er ferdig", async () => {
      await db.sourceItem.updateMany({
        where: { storyId, guid: "byraa-02" },
        data: { deleteAfter: new Date(NOW.getTime() + 10 * 60_000) },
      });
      const [candidate] = await findCandidates(db, config(), NOW);
      expect(candidate.items).toHaveLength(3);
    });

    it("sender ikke tekst som har passert sletteperioden", async () => {
      await db.sourceItem.updateMany({ where: { storyId, guid: "byraa-02" }, data: { deleteAfter: NOW } });
      const [candidate] = await findCandidates(db, config(), NOW);
      expect(candidate.items).toHaveLength(3);
    });

    it("sender bare tekst som kan analyseres til Claude", async () => {
      const paused = await db.source.findFirstOrThrow({ where: { slug: "pause" } });
      const item = await db.sourceItem.findFirstOrThrow({ where: { guid: "kommune-02" } });
      await db.sourceItem.update({ where: { id: item.id }, data: { sourceId: paused.id } });
      await db.sourceItem.updateMany({ where: { guid: "byraa-02" }, data: { tdmReserved: true } });
      const [candidate] = await findCandidates(db, config(), NOW);
      expect(candidate.items.map((i) => i.id).sort()).toHaveLength(2);
      expect(candidate.items.some((i) => i.id === item.id)).toBe(false);
    });
  });
});

describe("resolveAgents", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("skriver ikke uten nøkkel, når det er slått av, eller når grensen er 0", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(resolveAgents(config(), undefined)).toEqual({
      reason: "Skriving er ikke satt opp (krever ANTHROPIC_API_KEY)",
    });
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(resolveAgents(config({ enabled: false }), undefined)).toEqual({
      reason: "Skriving er slått av i konfigurasjonen",
    });
    expect(resolveAgents(config({ maxArticlesPerRun: 0 }), undefined)).toEqual({
      reason: "Skriving er slått av i konfigurasjonen",
    });
    expect(resolveAgents(config(), null)).toEqual({ reason: "Skriving er slått av" });
  });

  it("lager skriver og moderator med hver sin prompt når nøkkelen finnes", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const resolved = resolveAgents(config(), undefined);
    if (!("agents" in resolved)) throw new Error("forventet agenter");
    expect(resolved.agents.writer.promptVersion).toMatch(/^article-write@[0-9a-f]{12}$/);
    expect(resolved.agents.moderator.promptVersion).toMatch(/^article-moderate@[0-9a-f]{12}$/);
  });
});
