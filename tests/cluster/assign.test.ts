import { describe, expect, it, vi } from "vitest";
import { Clusterer, type Member, type StoryJudge } from "@/lib/cluster/assign";
import type { TermVector } from "@/lib/cluster/features";

const HOUR = 3600_000;

/**
 * Element med en vektor der likheten styres direkte: to elementer med samme ord
 * har likhet 1. Hvert element får sin egen kilde, med mindre en kilde oppgis.
 */
function member(id: string, hours: number, terms: Record<string, number>, sourceId = `kilde-${id}`): Member {
  const norm = Math.sqrt(Object.values(terms).reduce((sum, w) => sum + w * w, 0));
  const vector: TermVector = new Map(Object.entries(terms).map(([t, w]) => [t, w / norm]));
  return { id, sourceId, time: hours * HOUR, vector, text: { title: id, excerpt: null, bodyText: null } };
}

function clusterer(judge: StoryJudge | null = null, maxJudgeCalls = 10) {
  return new Clusterer({
    windowMs: 72 * HOUR,
    maxStoryMs: 168 * HOUR,
    sameStoryThreshold: 0.4,
    borderlineThreshold: 0.15,
    judge,
    maxJudgeCalls,
  });
}

// Likhet 1/3 mellom STORY og GREY: over 0,15 og under 0,4.
const STORY = { flom: 1 };
const GREY = { flom: 1, x: 1, y: 1, z: 1, w: 1, v: 1, u: 1, t: 1, s: 1 };

describe("Clusterer", () => {
  it("starter ny sak når ingen sak er åpen, og slår sammen over grensen", async () => {
    const c = clusterer();
    const first = await c.place(member("a", 0, { flom: 1, agder: 1 }));
    expect(first).toMatchObject({ isNew: true, method: "NEW", score: null, nearest: null });
    const second = await c.place(member("b", 1, { flom: 1, agder: 1, regn: 1 }));
    expect(second).toMatchObject({ isNew: false, method: "AUTO" });
    expect(second.story).toBe(first.story);
    expect(second.score).toBeCloseTo(2 / Math.sqrt(6));
  });

  it("lager ny sak under gråsonen uten å spørre", async () => {
    const judge = vi.fn<StoryJudge>();
    const c = clusterer(judge);
    await c.place(member("a", 0, { flom: 1 }));
    const placed = await c.place(member("b", 1, { flom: 1, a: 3, b: 3, c: 3, d: 3, e: 3, f: 3, g: 3 }));
    expect(placed.score).toBeLessThan(0.15);
    expect(placed.method).toBe("NEW");
    expect(judge).not.toHaveBeenCalled();
  });

  describe("samme kilde", () => {
    it("slår ikke sammen automatisk når den høye likheten bare er med samme kilde", async () => {
      const c = clusterer();
      await c.place(member("varsel-1", 0, { gult: 1, farevarsel: 1, more: 1, vind: 1 }, "met"));
      const placed = await c.place(member("varsel-2", 30, { gult: 1, farevarsel: 1, more: 1, regn: 1 }, "met"));
      expect(placed.score).toBeGreaterThan(0.4);
      expect(placed).toMatchObject({ isNew: true, method: "NEW" });
    });

    it("lar Claude avgjøre slike treff", async () => {
      const judge = vi.fn<StoryJudge>(async () => ({ match: "A", reason: "Varselet er oppgradert." }));
      const c = clusterer(judge);
      const first = await c.place(member("gult", 0, { farevarsel: 1, more: 1, vind: 1 }, "met"));
      const placed = await c.place(member("oransje", 20, { farevarsel: 1, more: 1, vind: 1, oransje: 1 }, "met"));
      expect(judge).toHaveBeenCalledTimes(1);
      expect(placed).toMatchObject({ method: "CLAUDE", story: first.story });
    });

    it("slår sammen automatisk når en annen kilde i saken ligner nok", async () => {
      const c = clusterer();
      const first = await c.place(member("met", 0, { farevarsel: 1, more: 1, vind: 1 }, "met"));
      await c.place(member("byra", 1, { farevarsel: 1, more: 1, vind: 1, kyst: 1 }, "byra"));
      const placed = await c.place(member("met-2", 20, { farevarsel: 1, more: 1, vind: 1, oransje: 1 }, "met"));
      expect(placed).toMatchObject({ method: "AUTO", story: first.story });
      // Likheten som lagres, er den med elementet fra den andre kilden.
      expect(placed.score).toBeCloseTo(3 / (2 * 2));
    });
  });

  describe("gråsonen", () => {
    it("blir ny sak og har nærmeste sak når ingen kan vurdere", async () => {
      const c = clusterer();
      const first = await c.place(member("a", 0, STORY));
      const placed = await c.place(member("b", 1, GREY));
      expect(placed.score).toBeCloseTo(1 / 3);
      expect(placed).toMatchObject({ isNew: true, method: "NEW", nearest: first.story });
    });

    it("følger Claude når svaret er samme sak, og tar med begrunnelsen", async () => {
      const judge = vi.fn<StoryJudge>(async () => ({ match: "A", reason: "Samme varsel." }));
      const c = clusterer(judge);
      const first = await c.place(member("a", 0, STORY));
      const placed = await c.place(member("b", 1, GREY));
      expect(placed).toMatchObject({ isNew: false, method: "CLAUDE", note: "Samme varsel." });
      expect(placed.story).toBe(first.story);
      expect(judge).toHaveBeenCalledWith({ title: "b", excerpt: null, bodyText: null }, [
        { key: "A", items: [{ title: "a", excerpt: null, bodyText: null }] },
      ]);
    });

    it("følger Claude når svaret er ny sak", async () => {
      const c = clusterer(async () => ({ match: null, reason: "Annet fylke." }));
      await c.place(member("a", 0, STORY));
      expect(await c.place(member("b", 1, GREY))).toMatchObject({
        isNew: true,
        method: "CLAUDE_NEW",
        note: "Annet fylke.",
      });
    });

    it.each([
      ["ukjent nøkkel", { match: "C", reason: "?" }],
      ["ingen avgjørelse", undefined],
    ])("lager ny sak ved %s", async (_name, verdict) => {
      const c = clusterer(async () => verdict);
      await c.place(member("a", 0, STORY));
      expect(await c.place(member("b", 1, GREY))).toMatchObject({ isNew: true, method: "NEW" });
    });

    it("sender opptil tre kandidatsaker i gråsonen, mest lik først, og lagrer likheten med den valgte", async () => {
      const judge = vi.fn<StoryJudge>(async () => ({ match: "B", reason: "" }));
      const c = clusterer(judge);
      // Fire saker som alle ligner det nye elementet litt, og én som ligner for lite.
      const s1 = await c.place(member("s1", 0, { p: 1, q: 3 }));
      await c.place(member("s2", 0, { p: 1, r: 2 }));
      await c.place(member("s3", 0, { p: 1, s: 4 }));
      await c.place(member("s4", 0, { p: 1, t: 5 }));
      await c.place(member("under", 0, { p: 1, z: 9 }));
      const placed = await c.place(member("ny", 1, { p: 1, u: 1 }));
      const candidates = judge.mock.calls[0][1];
      expect(candidates.map((cand) => cand.items[0].title)).toEqual(["s2", "s1", "s3"]);
      // «B» er den nest mest like saken.
      expect(placed.story).toBe(s1.story);
      expect(placed.score).toBeCloseTo(1 / (Math.sqrt(10) * Math.sqrt(2)));
    });

    it("sender bare kandidater over gråsonens nedre grense", async () => {
      const judge = vi.fn<StoryJudge>(async () => ({ match: null, reason: "" }));
      const c = clusterer(judge);
      await c.place(member("lik", 0, STORY));
      await c.place(member("ulik", 0, { flom: 1, a: 9 }));
      await c.place(member("ny", 1, GREY));
      expect(judge.mock.calls[0][1].map((cand) => cand.items[0].title)).toEqual(["lik"]);
    });

    it("viser Claude de fire nyeste elementene i en sak", async () => {
      const judge = vi.fn<StoryJudge>(async () => ({ match: null, reason: "" }));
      const c = clusterer(judge);
      for (let i = 1; i <= 6; i++) await c.place(member(`e${i}`, i, STORY));
      await c.place(member("ny", 10, GREY));
      expect(judge.mock.calls[0][1][0].items.map((item) => item.title)).toEqual(["e3", "e4", "e5", "e6"]);
    });

    it("stopper å spørre når grensen for antall kall er nådd", async () => {
      const judge = vi.fn<StoryJudge>(async () => ({ match: "A", reason: "" }));
      const c = clusterer(judge, 1);
      await c.place(member("a", 0, STORY));
      await c.place(member("b", 1, GREY));
      const third = await c.place(member("c", 2, { flom: 1, k: 1, l: 1, m: 1, n: 1, o: 1, p: 1, q: 1, r: 1 }));
      expect(judge).toHaveBeenCalledTimes(1);
      expect(third.method).not.toBe("CLAUDE");
    });
  });

  describe("tid", () => {
    it("tar bare med saker innenfor tidsvinduet fra første eller siste kilde", async () => {
      const c = clusterer();
      await c.place(member("a", 0, { flom: 1 }));
      expect(await c.place(member("b", 73, { flom: 1 }))).toMatchObject({ isNew: true, score: null });

      const c2 = clusterer();
      const first = await c2.place(member("a", 0, { flom: 1 }));
      await c2.place(member("b", 60, { flom: 1 }));
      expect((await c2.place(member("c", 120, { flom: 1 }))).story).toBe(first.story);
    });

    it("lar ikke en sak vokse lenger enn maksimal varighet", async () => {
      const c = clusterer();
      const first = await c.place(member("a", 0, { flom: 1 }));
      await c.place(member("b", 60, { flom: 1 }));
      await c.place(member("c", 120, { flom: 1 }));
      // Innenfor vinduet fra siste kilde, men saken ville dekket 180 timer.
      const late = await c.place(member("d", 180, { flom: 1 }));
      expect(late.isNew).toBe(true);
      expect(first.story.members.map((m) => m.id)).toEqual(["a", "b", "c"]);
    });

    it("tar imot et element som er publisert før sakens første kilde, innenfor vinduet", async () => {
      const c = clusterer();
      const first = await c.place(member("a", 50, { flom: 1 }));
      const earlier = await c.place(member("b", 10, { flom: 1 }));
      expect(earlier.story).toBe(first.story);
      expect(first.story).toMatchObject({ firstAt: 10 * HOUR, lastAt: 50 * HOUR });
      // Men ikke et som er publisert mer enn vinduet før.
      expect((await c.place(member("c", -70, { flom: 1 }))).isNew).toBe(true);
    });
  });

  it("sammenligner med det mest like elementet i saken", async () => {
    const c = clusterer();
    const first = await c.place(member("a", 0, { vind: 1, more: 1 }));
    await c.place(member("b", 1, { vind: 1, more: 1, ferje: 1, stengt: 1 }));
    // Ligner bare det andre elementet nok.
    const placed = await c.place(member("c", 2, { ferje: 1, stengt: 1, vind: 1 }));
    expect(placed.story).toBe(first.story);
  });

  it("kan angre en plassering og ta ut en sak som er borte", async () => {
    const c = clusterer();
    const m = member("a", 0, { flom: 1 });
    const placed = await c.place(m);
    c.retract(m, placed);
    expect(c.stories).toHaveLength(0);

    const other = await c.place(member("b", 0, { flom: 1 }));
    c.drop(other.story);
    expect((await c.place(member("c", 1, { flom: 1 }))).isNew).toBe(true);
  });
});
