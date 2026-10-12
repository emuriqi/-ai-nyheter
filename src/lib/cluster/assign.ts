import { cosine, type ItemText, type TermVector } from "./features";

/**
 * Selve grupperingen, uten database: ett og ett element plasseres i den mest
 * like åpne saken, eller starter en ny sak. Elementene må komme i
 * tidsrekkefølge. Fremgangsmåten er klassisk «single-pass» gruppering fra
 * forskningen på Topic Detection and Tracking.
 */

export type Member = {
  id: string;
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
  windowMs: number;
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

  /** Åpne saker sortert etter likhet med elementet, mest lik først. */
  rank(member: Member): { story: StoryState; score: number }[] {
    const { windowMs } = this.options;
    return this.stories
      .filter((story) => member.time >= story.firstAt - windowMs && member.time <= story.lastAt + windowMs)
      .map((story) => ({ story, score: storyScore(member, story) }))
      .sort((a, b) => b.score - a.score);
  }

  async place(member: Member): Promise<Placement> {
    const { sameStoryThreshold, borderlineThreshold, judge, maxJudgeCalls } = this.options;
    const ranked = this.rank(member);
    const best = ranked[0];
    const score = best ? best.score : null;
    const nearest = best ? best.story : null;

    if (best && best.score >= sameStoryThreshold) {
      return this.join(best.story, member, "AUTO", best.score);
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

/**
 * Likheten mellom et element og en sak er likheten med det mest like
 * elementet i saken. Det fanger opp at en sak utvikler seg: et nytt element
 * trenger bare å ligne på én av de tidligere kildene.
 */
export function storyScore(member: Member, story: StoryState): number {
  let best = 0;
  for (const other of story.members) best = Math.max(best, cosine(member.vector, other.vector));
  return best;
}
