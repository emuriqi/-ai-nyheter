import { cosine, type ItemText, type TermVector } from "./features";

/**
 * Selve grupperingen, uten database: ett og ett element plasseres i den mest
 * like åpne saken, eller starter en ny sak. Elementene må komme i
 * tidsrekkefølge. Fremgangsmåten er klassisk «single-pass» gruppering fra
 * forskningen på Topic Detection and Tracking.
 *
 * To regler holder presisjonen oppe:
 * - Bare likhet med et element fra en annen kilde kan slå sammen automatisk.
 *   To elementer fra samme kilde ligner ofte fordi kilden bruker faste maler
 *   (for eksempel to ulike farevarsler for samme fylke). Da avgjør Claude, og
 *   uten Claude blir elementet en egen sak.
 * - En sak kan ikke strekke seg over mer enn `maxStoryMs`, så ulike hendelser
 *   på samme sted ikke lenkes sammen i det uendelige.
 */

export type Member = {
  id: string;
  sourceId: string;
  /** Publiseringstid i millisekunder. */
  time: number;
  vector: TermVector;
  text: ItemText;
};

export type StoryState = {
  /** null til saken er lagret i databasen. */
  id: string | null;
  firstAt: number;
  lastAt: number;
  members: Member[];
};

export type ClusterMethod = "NEW" | "AUTO" | "CLAUDE" | "CLAUDE_NEW";

export type Placement = {
  story: StoryState;
  isNew: boolean;
  method: ClusterMethod;
  /** Likheten med den mest like åpne saken, null hvis ingen sak var åpen. */
  score: number | null;
  /** Den mest like åpne saken før elementet ble plassert. */
  nearest: StoryState | null;
  /** Claudes begrunnelse når Claude avgjorde. */
  note?: string;
};

export type JudgeCandidate = { key: string; items: ItemText[] };
/** `match` er nøkkelen til saken elementet hører til, eller null for ny sak. */
export type JudgeVerdict = { match: string | null; reason: string };
/**
 * Avgjør et element i gråsonen. Svarer `undefined` hvis det ikke kunne
 * avgjøres (feil, avslag eller ugyldig svar).
 */
export type StoryJudge = (item: ItemText, candidates: JudgeCandidate[]) => Promise<JudgeVerdict | undefined>;

export type ClustererOptions = {
  /** Hvor lenge etter sakens første eller siste kilde et nytt element kan legges til. */
  windowMs: number;
  /** Lengste tidsrom en sak kan dekke, fra første til siste kilde. */
  maxStoryMs: number;
  sameStoryThreshold: number;
  borderlineThreshold: number;
  judge: StoryJudge | null;
  maxJudgeCalls: number;
};

/** Så mange saker og elementer per sak vises til Claude i gråsonen. */
export const MAX_JUDGE_CANDIDATES = 3;
export const MAX_JUDGE_ITEMS_PER_STORY = 4;
const JUDGE_KEYS = ["A", "B", "C"] as const;

export class Clusterer {
  readonly stories: StoryState[] = [];
  judgeCalls = 0;

  constructor(private readonly options: ClustererOptions) {}

  /** Legger inn en sak som allerede finnes, med elementene sine. */
  addStory(story: StoryState): void {
    this.stories.push(story);
  }

  /** Tar ut en sak som ikke finnes lenger (for eksempel slettet av en redaktør under kjøringen). */
  drop(story: StoryState): void {
    const index = this.stories.indexOf(story);
    if (index >= 0) this.stories.splice(index, 1);
  }

  /**
   * Åpne saker sortert etter likhet med elementet, mest lik først. `score` er
   * likheten med det mest like elementet i saken, `crossSourceScore` det samme
   * regnet bare mot elementer fra andre kilder.
   */
  rank(member: Member): RankedStory[] {
    const { windowMs, maxStoryMs } = this.options;
    return this.stories
      .filter(
        (story) =>
          member.time >= story.firstAt - windowMs &&
          member.time <= story.lastAt + windowMs &&
          Math.max(story.lastAt, member.time) - Math.min(story.firstAt, member.time) <= maxStoryMs,
      )
      .map((story) => ({ story, ...storyScores(member, story) }))
      .sort((a, b) => b.score - a.score);
  }

  async place(member: Member): Promise<Placement> {
    const { sameStoryThreshold, borderlineThreshold, judge, maxJudgeCalls } = this.options;
    const ranked = this.rank(member);
    const best = ranked[0];
    const score = best ? best.score : null;
    const nearest = best ? best.story : null;

    const auto = ranked
      .filter((r) => r.crossSourceScore >= sameStoryThreshold)
      .sort((a, b) => b.crossSourceScore - a.crossSourceScore)[0];
    if (auto) {
      return this.join(auto.story, member, "AUTO", auto.crossSourceScore);
    }
    if (best && best.score >= borderlineThreshold && judge && this.judgeCalls < maxJudgeCalls) {
      const candidates = ranked.filter((r) => r.score >= borderlineThreshold).slice(0, MAX_JUDGE_CANDIDATES);
      this.judgeCalls++;
      const verdict = await judge(
        member.text,
        candidates.map((c, i) => ({
          key: JUDGE_KEYS[i],
          items: c.story.members.slice(-MAX_JUDGE_ITEMS_PER_STORY).map((m) => m.text),
        })),
      );
      if (verdict?.match === null) return this.start(member, "CLAUDE_NEW", score, nearest, verdict.reason);
      const index = verdict ? JUDGE_KEYS.indexOf(verdict.match as (typeof JUDGE_KEYS)[number]) : -1;
      const chosen = index >= 0 ? candidates[index] : undefined;
      if (verdict && chosen) return this.join(chosen.story, member, "CLAUDE", chosen.score, verdict.reason);
      // Ingen avgjørelse eller ukjent nøkkel: det trygge valget er en egen sak.
    }
    return this.start(member, "NEW", score, nearest);
  }

  /** Angrer en plassering som ikke kunne lagres. */
  retract(member: Member, placement: Placement): void {
    const { story } = placement;
    story.members = story.members.filter((m) => m !== member);
    if (placement.isNew && story.members.length === 0) {
      this.stories.splice(this.stories.indexOf(story), 1);
    }
  }

  private join(story: StoryState, member: Member, method: ClusterMethod, score: number, note?: string): Placement {
    story.members.push(member);
    story.firstAt = Math.min(story.firstAt, member.time);
    story.lastAt = Math.max(story.lastAt, member.time);
    return { story, isNew: false, method, score, nearest: story, note };
  }

  private start(
    member: Member,
    method: ClusterMethod,
    score: number | null,
    nearest: StoryState | null,
    note?: string,
  ): Placement {
    const story: StoryState = { id: null, firstAt: member.time, lastAt: member.time, members: [member] };
    this.stories.push(story);
    return { story, isNew: true, method, score, nearest, note };
  }
}

export type RankedStory = { story: StoryState; score: number; crossSourceScore: number };

/**
 * Likheten mellom et element og en sak er likheten med det mest like
 * elementet i saken. Det fanger opp at en sak utvikler seg: et nytt element
 * trenger bare å ligne på én av de tidligere kildene.
 */
export function storyScores(member: Member, story: StoryState): { score: number; crossSourceScore: number } {
  let score = 0;
  let crossSourceScore = 0;
  for (const other of story.members) {
    const similarity = cosine(member.vector, other.vector);
    score = Math.max(score, similarity);
    if (other.sourceId !== member.sourceId) crossSourceScore = Math.max(crossSourceScore, similarity);
  }
  return { score, crossSourceScore };
}
