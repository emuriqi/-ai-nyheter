import { Prisma } from "@/generated/prisma/client";
import { type ClaudeUsage, createClaudeClient } from "../ai/claude";
import type { SiteConfig } from "../config/schema";
import type { Db } from "../db";
import { truncate } from "../ingest/text";
import { DAY_MS, failStaleJobRuns, STALE_JOB_MS } from "../retention";
import { Clusterer, type Member, type Placement, type StoryJudge } from "./assign";
import { ANALYZABLE_ITEM } from "./eligibility";
import { clustererOptions } from "./options";
import { type ItemText, TermStats, termFrequencies, type TermVector, weigh } from "./features";
import { createClaudeJudge } from "./judge";
import { slugify, uniqueSlug } from "./slug";

export type ClusterStats = {
  /** Elementer som ble gruppert i denne kjøringen. */
  considered: number;
  newStories: number;
  /** Lagt til en eksisterende sak fordi likheten var over grensen. */
  joined: number;
  /** Lagt til en eksisterende sak etter vurdering fra Claude. */
  joinedByClaude: number;
  /** Ny sak etter vurdering fra Claude. */
  newByClaude: number;
  /**
   * Nye saker der likheten var i gråsonen uten at Claude avgjorde (Claude er
   * ikke satt opp, grensen for antall kall er nådd, eller kallet feilet).
   * Disse bør en redaktør se på.
   */
  uncertain: number;
  /**
   * Elementer som ikke ble lagret i denne kjøringen: en annen prosess rakk å
   * gruppere dem først, eller saken de skulle til ble endret eller slettet
   * underveis. De som fortsatt mangler sak, tas i neste kjøring.
   */
  skipped: number;
  claude: ClaudeUsage | null;
  promptVersion: string | null;
};

export type ClusterResult =
  | { status: "skipped"; reason: string }
  | { status: "done"; jobId: string; stats: ClusterStats }
  /** Bare fra runPipeline, som fanger feilen så slettingen likevel kjører. */
  | { status: "failed"; reason: string };

export type JudgeSetup = { judge: StoryJudge; usage: ClaudeUsage; promptVersion?: string };

export type ClusterOptions = {
  config: SiteConfig;
  trigger: string;
  now?: Date;
  /**
   * Hvem som avgjør elementer i gråsonen. Utelatt: Claude hvis det er slått på
   * i konfigurasjonen og ANTHROPIC_API_KEY er satt. null: ingen (gråsonen blir
   * nye saker).
   */
  judge?: JudgeSetup | null;
};

/** Så mange av de nyeste elementene brukes til å vekte ord. */
const MAX_REFERENCE_ITEMS = 5000;

const processLock = globalThis as unknown as { __aiNyheterClusterRunning?: boolean };

/**
 * Grupperer nye kildeelementer i saker.
 *
 * Bare elementer fra aktive kilder med lagret tekst grupperes. Elementer som
 * kilden har reservert mot tekst- og datautvinning, analyseres ikke og
 * grupperes derfor ikke. Hvert element havner i nøyaktig én sak; et element
 * som ikke ligner noen åpen sak, starter en ny.
 */
export async function runClusterJob(db: Db, options: ClusterOptions): Promise<ClusterResult> {
  if (processLock.__aiNyheterClusterRunning) {
    return { status: "skipped", reason: "En gruppering kjører allerede" };
  }
  processLock.__aiNyheterClusterRunning = true;
  try {
    return await runLocked(db, options);
  } finally {
    processLock.__aiNyheterClusterRunning = false;
  }
}

/**
 * Finner dommeren for gråsonen. Kan Claude ikke settes opp (for eksempel fordi
 * promptfilen mangler), grupperes det uten Claude, som når nøkkelen mangler.
 */
export function resolveJudge(config: SiteConfig, judge: JudgeSetup | null | undefined): JudgeSetup | null {
  if (judge !== undefined) return judge;
  if (!config.clustering.useClaudeForBorderline || config.clustering.maxClaudeChecksPerRun === 0) return null;
  try {
    const client = createClaudeClient();
    return client ? createClaudeJudge(client, config.ai.model) : null;
  } catch (error) {
    console.warn(`Grupperer uten Claude: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function runLocked(db: Db, options: ClusterOptions): Promise<ClusterResult> {
  const now = options.now ?? new Date();
  await failStaleJobRuns(db, now);
  const running = await db.jobRun.findFirst({
    where: { type: "CLUSTER", status: "RUNNING", startedAt: { gte: new Date(now.getTime() - STALE_JOB_MS) } },
  });
  if (running) return { status: "skipped", reason: "En gruppering kjører allerede" };

  const job = await db.jobRun.create({ data: { type: "CLUSTER", trigger: options.trigger, startedAt: now } });
  try {
    const judge = resolveJudge(options.config, options.judge);
    const stats = await cluster(db, options.config, now, judge);
    // Statusen skrives i en egen transaksjon, så den ikke kan havne inne i en
    // annen transaksjon på den delte SQLite-tilkoblingen og rulles tilbake med den.
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

const textSelect = {
  id: true,
  sourceId: true,
  title: true,
  excerpt: true,
  bodyText: true,
  publishedAt: true,
  fetchedAt: true,
} as const;
type TextRow = {
  id: string;
  sourceId: string;
  title: string;
  excerpt: string | null;
  bodyText: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
};

/**
 * Tidspunktet elementet sorteres og sammenlignes etter: publiseringstiden,
 * men aldri senere enn da vi hentet det (feeder kan ha feil dato).
 */
export function itemTime(row: { publishedAt: Date | null; fetchedAt: Date }): number {
  const fetched = row.fetchedAt.getTime();
  return row.publishedAt ? Math.min(row.publishedAt.getTime(), fetched) : fetched;
}

function itemText(row: TextRow): ItemText {
  return { title: row.title, excerpt: row.excerpt, bodyText: row.bodyText };
}

async function cluster(db: Db, config: SiteConfig, now: Date, judge: JudgeSetup | null): Promise<ClusterStats> {
  const settings = config.clustering;
  const windowMs = settings.storyWindowHours * HOUR_MS;
  const stats: ClusterStats = {
    considered: 0,
    newStories: 0,
    joined: 0,
    joinedByClaude: 0,
    newByClaude: 0,
    uncertain: 0,
    skipped: 0,
    claude: judge?.usage ?? null,
    promptVersion: judge?.promptVersion ?? null,
  };

  // Eldste først, så sakene bygges opp i den rekkefølgen kildene kom.
  const candidates = (
    await db.sourceItem.findMany({
      where: { storyId: null, ...ANALYZABLE_ITEM },
      orderBy: { fetchedAt: "asc" },
      take: settings.maxItemsPerRun,
      select: textSelect,
    })
  ).sort((a, b) => itemTime(a) - itemTime(b) || a.id.localeCompare(b.id));
  if (candidates.length === 0) return stats;

  const first = itemTime(candidates[0]);
  const last = itemTime(candidates[candidates.length - 1]);
  const openStories = await db.story.findMany({
    where: {
      lastSourceAt: { gte: new Date(first - windowMs) },
      firstSeenAt: { lte: new Date(last + windowMs) },
    },
    select: {
      id: true,
      firstSeenAt: true,
      lastSourceAt: true,
      // Bare tekst som kan analyseres, sammenlignes og sendes til Claude.
      items: { where: ANALYZABLE_ITEM, select: textSelect, orderBy: [{ publishedAt: "asc" }, { fetchedAt: "asc" }] },
    },
  });

  // Ordvekter fra nyere elementer, pluss alle elementene som skal sammenlignes.
  const reference = await db.sourceItem.findMany({
    where: { ...ANALYZABLE_ITEM, fetchedAt: { gte: new Date(now.getTime() - settings.idfWindowDays * DAY_MS) } },
    orderBy: { fetchedAt: "desc" },
    take: MAX_REFERENCE_ITEMS,
    select: textSelect,
  });
  const frequencies = new Map<string, TermVector>();
  for (const row of [...reference, ...candidates, ...openStories.flatMap((s) => s.items)]) {
    if (!frequencies.has(row.id)) frequencies.set(row.id, termFrequencies(itemText(row)));
  }
  const termStats = new TermStats(frequencies.values());
  const toMember = (row: TextRow): Member => ({
    id: row.id,
    sourceId: row.sourceId,
    time: itemTime(row),
    vector: weigh(frequencies.get(row.id)!, termStats),
    text: itemText(row),
  });

  const clusterer = new Clusterer(clustererOptions(settings, judge?.judge ?? null));
  // En sak uten elementer som kan analyseres, kan ikke sammenlignes og er ikke kandidat.
  for (const story of openStories.filter((s) => s.items.length > 0)) {
    clusterer.addStory({
      id: story.id,
      firstAt: story.firstSeenAt.getTime(),
      lastAt: story.lastSourceAt.getTime(),
      // Eldste først, som når saken bygges i minnet, så Claude ser de nyeste elementene.
      members: story.items.map(toMember).sort((a, b) => a.time - b.time),
    });
  }

  for (const row of candidates) {
    const member = toMember(row);
    const placement = await clusterer.place(member);
    const outcome = await persist(db, row, member, placement, now);
    if (outcome !== "saved") {
      clusterer.retract(member, placement);
      // Saken finnes ikke lenger. Neste kjøring grupperer elementet på nytt.
      if (outcome === "story-gone") clusterer.drop(placement.story);
      stats.skipped++;
      continue;
    }
    stats.considered++;
    if (placement.method === "NEW") {
      stats.newStories++;
      if (placement.score !== null && placement.score >= settings.borderlineThreshold) stats.uncertain++;
    } else if (placement.method === "AUTO") stats.joined++;
    else if (placement.method === "CLAUDE") stats.joinedByClaude++;
    else if (placement.method === "CLAUDE_NEW") stats.newByClaude++;
  }
  return stats;
}

type PersistOutcome = "saved" | "already-clustered" | "story-gone" | "slug-taken";

/**
 * Lagrer plasseringen i én transaksjon. Hvis noe er endret av andre underveis
 * (elementet er allerede gruppert, saken er slettet, eller slugen ble tatt
 * samtidig), lagres ingenting, og elementet tas i neste kjøring. Andre feil
 * stopper jobben.
 *
 * Transaksjonen kaster ikke ved forventede utfall: SQLite-adapteren deler én
 * tilkobling i prosessen, så en tilbakerulling kan ta med seg samtidige
 * skrivinger fra andre oppgaver. Det som allerede er skrevet, ryddes i stedet
 * opp i samme transaksjon.
 */
async function persist(db: Db, row: TextRow, member: Member, placement: Placement, now: Date): Promise<PersistOutcome> {
  const { story } = placement;
  const itemData = {
    clusteredAt: now,
    clusterMethod: placement.method,
    clusterScore: placement.score,
    clusterNote: placement.note ?? null,
    clusterNearestStoryId: placement.isNew ? (placement.nearest?.id ?? null) : null,
  };
  const claim = async (tx: Prisma.TransactionClient, storyId: string) =>
    (await tx.sourceItem.updateMany({ where: { id: row.id, storyId: null }, data: { ...itemData, storyId } })).count >
    0;

  try {
    const result = await db.$transaction(async (tx): Promise<{ outcome: PersistOutcome; id?: string }> => {
      if (story.id === null) {
        const id = await createStory(tx, row, member.time);
        if (await claim(tx, id)) return { outcome: "saved", id };
        await tx.story.delete({ where: { id } });
        return { outcome: "already-clustered" };
      }
      const id = story.id;
      // Tidsrommet regnes fra det som står i databasen, ikke fra minnet, så
      // endringer en redaktør har gjort under kjøringen ikke overskrives.
      const current = await tx.story.findUnique({ where: { id }, select: { firstSeenAt: true, lastSourceAt: true } });
      if (!current) return { outcome: "story-gone" };
      if (!(await claim(tx, id))) return { outcome: "already-clustered" };
      await tx.story.update({
        where: { id },
        data: {
          firstSeenAt: new Date(Math.min(current.firstSeenAt.getTime(), member.time)),
          lastSourceAt: new Date(Math.max(current.lastSourceAt.getTime(), member.time)),
        },
      });
      return { outcome: "saved", id };
    });
    if (result.id) story.id = result.id;
    return result.outcome;
  } catch (error) {
    // Unik slug tatt av en annen prosess i samme øyeblikk.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "slug-taken";
    throw error;
  }
}

async function createStory(tx: Prisma.TransactionClient, row: TextRow, time: number): Promise<string> {
  const slug = await uniqueSlug(
    slugify(row.title),
    async (candidate) => (await tx.story.count({ where: { slug: candidate } })) > 0,
  );
  const created = await tx.story.create({
    data: { slug, workingTitle: truncate(row.title, 200), firstSeenAt: new Date(time), lastSourceAt: new Date(time) },
    select: { id: true },
  });
  return created.id;
}

const HOUR_MS = 60 * 60 * 1000;
