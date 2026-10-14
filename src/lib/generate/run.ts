import { Prisma } from "@/generated/prisma/client";
import { type ClaudeUsage, createClaudeClient } from "../ai/claude";
import { ANALYZABLE_ITEM } from "../cluster/eligibility";
import type { SiteConfig } from "../config/schema";
import type { Db } from "../db";
import { truncate } from "../ingest/text";
import { failStaleJobRuns, STALE_JOB_MS } from "../retention";
import { checkArticle } from "./checks";
import { type ArticleModerator, type ArticleWriter, createClaudeModerator, createClaudeWriter } from "./claude";
import { type Decision, decide } from "./decide";
import type { WrittenArticle } from "./schema";
import { type PreparedSource, prepareSources } from "./sources";

export type GenerateStats = {
  /** Saker som var klare for artikkel i denne kjøringen. */
  considered: number;
  /** Nye artikler som venter på godkjenning. */
  pendingReview: number;
  /** Nye artikler publisert uten manuell godkjenning (bare med manualApproval FLAGGED_ONLY). */
  published: number;
  /** Av de nye artiklene: hvor mange som ble flagget, og hvor mange som har brudd på en fast regel. */
  flagged: number;
  blocked: number;
  /** Saker der skrivingen feilet. De prøves igjen i neste kjøring, opptil maxAttemptsPerStory ganger. */
  failed: number;
  /** Saker som fikk en artikkel fra en annen prosess i mellomtiden. */
  skipped: number;
  writer: ClaudeUsage | null;
  moderator: ClaudeUsage | null;
  promptVersion: string | null;
};

export type GenerateResult =
  | { status: "skipped"; reason: string }
  | { status: "done"; jobId: string; stats: GenerateStats }
  /** Bare fra runPipeline, som fanger feilen så slettingen likevel kjører. */
  | { status: "failed"; reason: string };

export type GenerateAgents = { writer: ArticleWriter; moderator: ArticleModerator };

export type GenerateOptions = {
  config: SiteConfig;
  trigger: string;
  now?: Date;
  /**
   * Hvem som skriver og kontrollerer. Utelatt: Claude hvis generering er slått
   * på i konfigurasjonen og ANTHROPIC_API_KEY er satt. null: ingen generering.
   */
  agents?: GenerateAgents | null;
};

const processLock = globalThis as unknown as { __aiNyheterGenerateRunning?: boolean };

/**
 * Finner skriver og moderator, eller årsaken til at det ikke skrives. Uten
 * nøkkel, eller hvis oppsettet feiler, lages ingen artikler.
 */
export function resolveAgents(
  config: SiteConfig,
  agents: GenerateAgents | null | undefined,
): { agents: GenerateAgents } | { reason: string } {
  if (agents === null) return { reason: "Skriving er slått av" };
  if (agents) return { agents };
  if (!config.generation.enabled || config.generation.maxArticlesPerRun === 0) {
    return { reason: "Skriving er slått av i konfigurasjonen" };
  }
  try {
    const client = createClaudeClient();
    if (!client) return { reason: "Skriving er ikke satt opp (krever ANTHROPIC_API_KEY)" };
    return {
      agents: {
        writer: createClaudeWriter(client, config.ai.model, config.editorial),
        moderator: createClaudeModerator(client, config.ai.model, config.editorial),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Skriver ingen artikler: ${message}`);
    return { reason: `Skriving kunne ikke settes opp: ${message}` };
  }
}

/**
 * Skriver artikler for saker som er klare, kontrollerer dem og lagrer dem som
 * utkast til godkjenning (eller publiserer, hvis konfigurasjonen tillater det
 * og ingenting er flagget).
 *
 * Bare tekst som kan analyseres (se ANALYZABLE_ITEM), sendes til Claude. Hver
 * artikkel kontrolleres to ganger: automatisk (sitater, kopiert tekst, tall,
 * kilder, personer) og av Claude i et eget kall med egen prompt.
 */
export async function runGenerateJob(db: Db, options: GenerateOptions): Promise<GenerateResult> {
  const resolved = resolveAgents(options.config, options.agents);
  if (!("agents" in resolved)) return { status: "skipped", reason: resolved.reason };
  const { agents } = resolved;
  if (processLock.__aiNyheterGenerateRunning) return { status: "skipped", reason: "En skriving kjører allerede" };
  processLock.__aiNyheterGenerateRunning = true;
  try {
    return await runLocked(db, options, agents);
  } finally {
    processLock.__aiNyheterGenerateRunning = false;
  }
}

async function runLocked(db: Db, options: GenerateOptions, agents: GenerateAgents): Promise<GenerateResult> {
  const now = options.now ?? new Date();
  await failStaleJobRuns(db, now);
  const running = await db.jobRun.findFirst({
    where: { type: "GENERATE", status: "RUNNING", startedAt: { gte: new Date(now.getTime() - STALE_JOB_MS) } },
  });
  if (running) return { status: "skipped", reason: "En skriving kjører allerede" };

  const job = await db.jobRun.create({ data: { type: "GENERATE", trigger: options.trigger, startedAt: now } });
  try {
    const stats = await generate(db, options.config, now, agents);
    // Statusen skrives i en egen transaksjon, så den ikke kan rulles tilbake sammen med en annen.
    await db.$transaction([
      db.jobRun.update({
        where: { id: job.id },
        data: { status: "SUCCEEDED", finishedAt: new Date(), stats: stats as unknown as Prisma.InputJsonValue },
      }),
    ]);
    return { status: "done", jobId: job.id, stats };
  } catch (error) {
    await db.$transaction([
      db.jobRun.update({
        where: { id: job.id },
        data: { status: "FAILED", finishedAt: new Date(), error: String(error) },
      }),
    ]);
    throw error;
  }
}

const sourceSelect = {
  id: true,
  title: true,
  url: true,
  excerpt: true,
  bodyText: true,
  publishedAt: true,
  fetchedAt: true,
  source: { select: { name: true, publisher: true } },
} as const;

/** Saker som er klare for en første artikkel. */
export async function findCandidates(db: Db, config: SiteConfig, now: Date) {
  const g = config.generation;
  const stories = await db.story.findMany({
    where: {
      article: null,
      generationAttempts: { lt: g.maxAttemptsPerStory },
      firstSeenAt: { gte: new Date(now.getTime() - g.maxStoryAgeHours * 3600_000) },
      // Vent til saken har vært stille en stund, så kilder som kommer samtidig, kommer med.
      lastSourceAt: { lte: new Date(now.getTime() - g.settleMinutes * 60_000) },
      items: { some: ANALYZABLE_ITEM },
    },
    orderBy: { lastSourceAt: "desc" },
    select: { id: true, slug: true, items: { where: ANALYZABLE_ITEM, select: sourceSelect } },
  });
  return stories.filter((s) => s.items.length >= g.minSourcesPerStory).slice(0, g.maxArticlesPerRun);
}

async function generate(db: Db, config: SiteConfig, now: Date, agents: GenerateAgents): Promise<GenerateStats> {
  const { writer, moderator } = agents;
  const stats: GenerateStats = {
    considered: 0,
    pendingReview: 0,
    published: 0,
    flagged: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    writer: writer.usage,
    moderator: moderator.usage,
    promptVersion: `${writer.promptVersion}+${moderator.promptVersion}`,
  };

  for (const story of await findCandidates(db, config, now)) {
    stats.considered++;
    const sources = prepareSources(story.items, config.generation);
    const written = await writer.write(sources);
    if (!written.ok) {
      stats.failed++;
      await db.story.update({
        where: { id: story.id },
        data: {
          generationAttempts: { increment: 1 },
          lastGenerationAt: now,
          lastGenerationError: truncate(written.reason, 300),
        },
      });
      continue;
    }

    const article = written.article;
    const checks = checkArticle(article, sources, config.editorial);
    const moderation = await moderator.moderate(sources, article);
    const decision = decide(article, checks, moderation, config.editorial);
    const saved = await saveArticle(db, {
      storyId: story.id,
      article,
      sources,
      decision,
      now,
      model: writer.model,
      promptVersion: stats.promptVersion!,
      moderatorModel: moderation.ok ? moderator.model : null,
    });
    if (!saved) {
      stats.skipped++;
      continue;
    }
    if (decision.autoPublish) stats.published++;
    else stats.pendingReview++;
    if (decision.verdict === "FLAGGED") stats.flagged++;
    if (decision.blocked) stats.blocked++;
  }
  return stats;
}

type SaveInput = {
  storyId: string;
  article: WrittenArticle;
  sources: PreparedSource[];
  decision: Decision;
  now: Date;
  model: string;
  promptVersion: string;
  moderatorModel: string | null;
};

/**
 * Lagrer artikkelen med første versjon, kildene den bygger på og
 * modereringen, i én transaksjon. Returnerer false hvis saken fikk en artikkel
 * fra en annen prosess i mellomtiden.
 */
async function saveArticle(db: Db, input: SaveInput): Promise<boolean> {
  const { article, decision, now } = input;
  const usedKeys = new Set(article.kilder_brukt);
  // Kildene artikkelen sier den bygger på. Sier den ingenting gyldig, regnes alle som brukt.
  const used = input.sources.filter((s) => usedKeys.has(s.key));
  const revisionSources = (used.length > 0 ? used : input.sources).map((s) => ({ sourceItemId: s.itemId }));
  const status = decision.autoPublish ? "PUBLISHED" : "PENDING_REVIEW";

  try {
    await db.$transaction(async (tx) => {
      await tx.article.create({
        data: {
          storyId: input.storyId,
          title: article.tittel,
          lede: article.ingress,
          body: article.brodtekst,
          version: 1,
          status,
          model: input.model,
          promptVersion: input.promptVersion,
          publishedAt: decision.autoPublish ? now : null,
          revisions: {
            create: {
              version: 1,
              type: "CREATED",
              title: article.tittel,
              lede: article.ingress,
              body: article.brodtekst,
              changeSummary: "Første versjon",
              reason: `Ny sak fra ${revisionSources.length} ${revisionSources.length === 1 ? "kilde" : "kilder"}`,
              createdBy: "AI",
              model: input.model,
              promptVersion: input.promptVersion,
              createdAt: now,
              sources: { create: revisionSources },
              moderation: {
                create: {
                  verdict: decision.verdict,
                  reasons: decision.findings as unknown as Prisma.InputJsonValue,
                  checkedBy: input.moderatorModel ? "AI" : "SYSTEM",
                  model: input.moderatorModel,
                  decision: decision.autoPublish ? "APPROVED" : "PENDING",
                  decidedBy: decision.autoPublish ? "SYSTEM" : null,
                  decidedAt: decision.autoPublish ? now : null,
                  decisionNote: decision.autoPublish ? "Publisert automatisk: ingen funn i kontrollene." : null,
                },
              },
            },
          },
        },
      });
      await tx.story.update({
        where: { id: input.storyId },
        data: {
          category: article.kategori,
          sensitivity: decision.sensitiveThemes.length > 0 ? "SENSITIVE" : "NORMAL",
          sensitivityReasons: decision.sensitiveThemes,
          lastGenerationAt: now,
          lastGenerationError: null,
        },
      });
    });
    return true;
  } catch (error) {
    // Saken fikk en artikkel fra en annen prosess (storyId er unik).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}
