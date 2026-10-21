import { Prisma } from "@/generated/prisma/client";
import { type ClaudeUsage, createClaudeClient, hasClaudeKey } from "../ai/claude";
import { analyzableItemAt } from "../cluster/eligibility";
import type { SiteConfig } from "../config/schema";
import type { Db } from "../db";
import { truncate } from "../ingest/text";
import { failStaleJobRuns, STALE_JOB_MS } from "../retention";
import { checkArticle, stripSourceRefs } from "./checks";
import { type ArticleModerator, type ArticleWriter, createClaudeModerator, createClaudeWriter } from "./claude";
import { type Decision, decide } from "./decide";
import type { WrittenArticle } from "./schema";
import { type PreparedSource, prepareSources } from "./sources";

export type GenerateStats = {
  /** Saker som ble forsøkt skrevet i denne kjøringen. */
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
  /** Av sakene som feilet: hvor mange som nå har brukt opp forsøkene sine. */
  gaveUp: number;
  /** Saker der kildene ble endret mens artikkelen ble skrevet. De skrives på nytt i neste kjøring. */
  changed: number;
  /** Saker som fikk en artikkel fra en annen prosess i mellomtiden. */
  skipped: number;
  /** Hvorfor kjøringen stoppet før alle sakene var forsøkt, ellers null. */
  stopped: string | null;
  writer: ClaudeUsage | null;
  moderator: ClaudeUsage | null;
  promptVersion: string | null;
};

export type GenerateResult =
  | { status: "skipped"; reason: string }
  | { status: "done"; jobId: string; stats: GenerateStats }
  /** En feil hos Claude API (nøkkel, tilgang, overbelastning) stoppet kjøringen. Jobben er merket som feilet. */
  | { status: "stopped"; jobId: string; stats: GenerateStats; reason: string }
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
  /** Tidsfrist for kjøringen. Utelatt: GENERATE_BUDGET_MS. */
  budgetMs?: number;
};

/**
 * Etter så lang tid starter ikke kjøringen på flere saker. Ett skrive- og ett
 * modereringskall tar høyst rundt ti minutter hver (tidsgrense og ett nytt
 * forsøk), så jobben blir ferdig lenge før den regnes som foreldet
 * (STALE_JOB_MS) og en annen prosess kan starte en ny skriving.
 */
export const GENERATE_BUDGET_MS = 40 * 60_000;

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
  if (!generationEnabled(config)) {
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
  let stats: GenerateStats;
  try {
    stats = await generate(db, options.config, now, agents, options.budgetMs ?? GENERATE_BUDGET_MS);
  } catch (error) {
    // Statusen skrives i en egen transaksjon, så den ikke kan rulles tilbake sammen med en annen.
    await db.$transaction([
      db.jobRun.update({
        where: { id: job.id },
        data: { status: "FAILED", finishedAt: new Date(), error: String(error) },
      }),
    ]);
    throw error;
  }
  // Stoppet av en feil hos Claude API: jobben feilet, men det som ble lagret, står.
  const stoppedByClaude = stats.stopped !== null && stats.stopped !== DEADLINE_REASON;
  await db.$transaction([
    db.jobRun.update({
      where: { id: job.id },
      data: {
        status: stoppedByClaude ? "FAILED" : "SUCCEEDED",
        finishedAt: new Date(),
        stats: stats as unknown as Prisma.InputJsonValue,
        error: stoppedByClaude ? stats.stopped : null,
      },
    }),
  ]);
  return stoppedByClaude
    ? { status: "stopped", jobId: job.id, stats, reason: stats.stopped! }
    : { status: "done", jobId: job.id, stats };
}

const DEADLINE_REASON = "tidsfristen for kjøringen er nådd";

/** true hvis skriving er slått på i konfigurasjonen. Krever i tillegg ANTHROPIC_API_KEY. */
export function generationEnabled(config: SiteConfig): boolean {
  return config.generation.enabled && config.generation.maxArticlesPerRun > 0;
}

const sourceSelect = {
  id: true,
  title: true,
  url: true,
  excerpt: true,
  bodyText: true,
  publishedAt: true,
  fetchedAt: true,
  language: true,
  source: { select: { name: true, publisher: true } },
} as const;

/** Vilkårene for at en sak er klar for en første artikkel. */
function candidateWhere(config: SiteConfig, now: Date): Prisma.StoryWhereInput {
  const g = config.generation;
  const settled = new Date(now.getTime() - g.settleMinutes * 60_000);
  return {
    article: null,
    generationAttempts: { lt: g.maxAttemptsPerStory },
    firstSeenAt: { gte: new Date(now.getTime() - g.maxStoryAgeHours * 3600_000) },
    // Vent til saken har vært stille en stund, så kilder som kommer samtidig, kommer med.
    // Både kildenes tid og når de ble lagt i saken teller: en kilde kan hentes lenge etter at den ble publisert.
    lastSourceAt: { lte: settled },
    items: { some: analyzableItemAt(now), none: { clusteredAt: { gt: settled } } },
  };
}

function candidateSelect(now: Date) {
  return {
    id: true,
    slug: true,
    generationAttempts: true,
    items: { where: analyzableItemAt(now), select: sourceSelect },
  } as const;
}

/** Saker som er klare for en første artikkel. */
export async function findCandidates(db: Db, config: SiteConfig, now: Date) {
  const stories = await db.story.findMany({
    where: candidateWhere(config, now),
    orderBy: { lastSourceAt: "desc" },
    select: candidateSelect(now),
  });
  return stories
    .filter((s) => s.items.length >= config.generation.minSourcesPerStory)
    .slice(0, config.generation.maxArticlesPerRun);
}

/** Saken med kildene slik de er nå, hvis den fortsatt er klar for en artikkel. */
async function reloadCandidate(db: Db, config: SiteConfig, storyId: string, now: Date) {
  const story = await db.story.findFirst({
    where: { ...candidateWhere(config, now), id: storyId },
    select: candidateSelect(now),
  });
  return story && story.items.length >= config.generation.minSourcesPerStory ? story : null;
}

/** Hvorfor en sak ikke vil få en ny artikkel ved neste kjøring, eller null hvis den vil. */
export type NotWrittenReason = "skriving-av" | "for-gammel" | "for-faa-kilder" | "ukjent-sak";

/**
 * Sjekker om en sak uten artikkel blir skrevet ved neste kjøring. Brukes før
 * et utkast slettes eller en sak prøves igjen, så redaktøren ikke mister
 * utkastet til en sak som aldri blir skrevet på nytt.
 */
export async function whyNotWritten(
  db: Db,
  config: SiteConfig,
  storyId: string,
  now: Date,
  canWrite = hasClaudeKey(),
): Promise<NotWrittenReason | null> {
  if (!generationEnabled(config) || !canWrite) return "skriving-av";
  const story = await db.story.findUnique({
    where: { id: storyId },
    select: { firstSeenAt: true, _count: { select: { items: { where: analyzableItemAt(now) } } } },
  });
  if (!story) return "ukjent-sak";
  // Saken må fortsatt være ung nok når neste kjøring kommer. Innhentingen kjører
  // høyst så ofte som minIntervalMinutes, så to intervaller gir god margin.
  const margin = 2 * config.ingestion.minIntervalMinutes * 60_000;
  if (story.firstSeenAt.getTime() < now.getTime() - config.generation.maxStoryAgeHours * 3600_000 + margin) {
    return "for-gammel";
  }
  if (story._count.items < config.generation.minSourcesPerStory) return "for-faa-kilder";
  return null;
}

async function generate(
  db: Db,
  config: SiteConfig,
  now: Date,
  agents: GenerateAgents,
  budgetMs: number,
): Promise<GenerateStats> {
  const { writer, moderator } = agents;
  const started = Date.now();
  const stats: GenerateStats = {
    considered: 0,
    pendingReview: 0,
    published: 0,
    flagged: 0,
    blocked: 0,
    failed: 0,
    gaveUp: 0,
    changed: 0,
    skipped: 0,
    stopped: null,
    writer: writer.usage,
    moderator: moderator.usage,
    promptVersion: `${writer.promptVersion}+${moderator.promptVersion}`,
  };

  for (const candidate of await findCandidates(db, config, now)) {
    if (stats.considered > 0 && Date.now() - started >= budgetMs) {
      stats.stopped = DEADLINE_REASON;
      break;
    }
    // Les kildene på nytt: de kan ha blitt flyttet mens tidligere saker ble skrevet.
    const story = await reloadCandidate(db, config, candidate.id, now);
    if (!story) continue;
    stats.considered++;
    const sources = prepareSources(story.items, config.generation);
    const written = await writer.write(sources, now);
    if (!written.ok) {
      if (written.stopRun) {
        // Feilen gjelder API-et eller nøkkelen, ikke saken, så forsøket telles ikke.
        stats.stopped = written.reason;
        break;
      }
      stats.failed++;
      if (story.generationAttempts + 1 >= config.generation.maxAttemptsPerStory) stats.gaveUp++;
      // updateMany kaster ikke hvis saken er slettet i mellomtiden.
      await db.story.updateMany({
        where: { id: story.id },
        data: {
          generationAttempts: { increment: 1 },
          lastGenerationAt: now,
          lastGenerationError: truncate(written.reason, 300),
        },
      });
      continue;
    }

    // Kildehenvisninger som [K1] fjernes før kontrollene, så leserne aldri ser dem.
    const { article, findings: refFindings } = stripSourceRefs(written.article);
    const checks = [...refFindings, ...checkArticle(article, sources, config.editorial)];
    const moderation = await moderator.moderate(sources, article, now);
    if (!moderation.ok && moderation.stopRun) {
      // Uten moderering lagres ingenting. Saken skrives på nytt i neste kjøring.
      stats.stopped = moderation.reason;
      break;
    }
    const decision = decide(article, checks, moderation, config.editorial);
    const saved = await saveArticle(db, {
      storyId: story.id,
      itemIds: story.items.map((item) => item.id),
      article,
      sources,
      decision,
      now,
      model: writer.model,
      promptVersion: stats.promptVersion!,
      moderatorModel: moderation.ok ? moderator.model : null,
    });
    if (saved === "changed") {
      stats.changed++;
      continue;
    }
    if (saved === "exists") {
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
  /** Alle analyserbare elementer i saken da kildene ble lest. */
  itemIds: string[];
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
 * modereringen, i én transaksjon.
 *
 * Transaksjonen kaster ikke ved forventede utfall (se forklaringen i
 * src/lib/cluster/manual.ts). Den sjekker først at saken finnes, ikke har fått
 * en artikkel og har de samme kildene som da artikkelen ble skrevet. Er
 * kildene flyttet i mellomtiden, lagres ingenting, og saken skrives på nytt i
 * neste kjøring.
 */
async function saveArticle(db: Db, input: SaveInput): Promise<"saved" | "changed" | "exists"> {
  const { article, decision, now } = input;
  // Alle kildene Claude fikk se, er grunnlaget for artikkelen, og vises og krediteres på siden.
  const revisionSources = input.sources.map((s) => ({ sourceItemId: s.itemId }));
  const status = decision.autoPublish ? "PUBLISHED" : "PENDING_REVIEW";

  try {
    return await db.$transaction(async (tx) => {
      const story = await tx.story.findUnique({
        where: { id: input.storyId },
        select: { article: { select: { id: true } }, items: { where: analyzableItemAt(now), select: { id: true } } },
      });
      if (!story) return "changed";
      if (story.article) return "exists";
      const current = new Set(story.items.map((item) => item.id));
      if (current.size !== input.itemIds.length || input.itemIds.some((id) => !current.has(id))) return "changed";

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
                  decisionNote: decision.autoPublish ? "Publisert automatisk: ingen funn som krever vurdering." : null,
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
          sensitivity: decision.sensitive ? "SENSITIVE" : "NORMAL",
          sensitivityReasons:
            decision.sensitiveThemes.length > 0
              ? decision.sensitiveThemes
              : decision.sensitive
                ? ["sensitivt tema"]
                : [],
          lastGenerationAt: now,
          lastGenerationError: null,
        },
      });
      return "saved";
    });
  } catch (error) {
    // En annen prosess lagret en artikkel for saken mellom sjekken og lagringen (storyId er unik).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "exists";
    throw error;
  }
}
