import { describe, expect, it, vi } from "vitest";
import { Clusterer, type Member, type StoryJudge } from "@/lib/cluster/assign";
import type { TermVector } from "@/lib/cluster/features";

const HOUR = 3600_000;

/** Element med en vektor der likheten styres direkte: to elementer med samme ord har likhet 1. */
function member(id: string, hours: number, terms: Record<string, number>): Member {
  const norm = Math.sqrt(Object.values(terms).reduce((sum, w) => sum + w * w, 0));
  const vector: TermVector = new Map(Object.entries(terms).map(([t, w]) => [t, w / norm]));
  return { id, time: hours * HOUR, vector, text: { title: id, excerpt: null, bodyText: null } };
}

function clusterer(judge: StoryJudge | null = null, maxJudgeCalls = 10) {
  return new Clusterer({
    windowMs: 72 * HOUR,
    sameStoryThreshold: 0.4,
    borderlineThreshold: 0.15,
    judge,
    maxJudgeCalls,
  });
}

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

  describe("gråsonen", () => {
    // Likhet 1/3: over 0,15 og under 0,4.
    const story = { flom: 1 };
    const grey = { flom: 1, x: 1, y: 1, z: 1, w: 1, v: 1, u: 1, t: 1, s: 1 };

    it("blir ny sak og har nærmeste sak når ingen kan vurdere", async () => {
      const c = clusterer();
      const first = await c.place(member("a", 0, story));
      const placed = await c.place(member("b", 1, grey));
      expect(placed.score).toBeCloseTo(1 / 3);
      expect(placed).toMatchObject({ isNew: true, method: "NEW", nearest: first.story });
    });

    it("følger Claude når svaret er samme sak, og tar med begrunnelsen", async () => {
      const judge = vi.fn<StoryJudge>(async () => ({ match: "A", reason: "Samme varsel." }));
      const c = clusterer(judge);
      const first = await c.place(member("a", 0, story));
      const placed = await c.place(member("b", 1, grey));
      expect(placed).toMatchObject({ isNew: false, method: "CLAUDE", note: "Samme varsel." });
      expect(placed.story).toBe(first.story);
      expect(judge).toHaveBeenCalledWith({ title: "b", excerpt: null, bodyText: null }, [
        { key: "A", items: [{ title: "a", excerpt: null, bodyText: null }] },
      ]);
    });

    it("følger Claude når svaret er ny sak", async () => {
      const c = clusterer(async () => ({ match: null, reason: "Annet fylke." }));
      await c.place(member("a", 0, story));
      expect(await c.place(member("b", 1, grey))).toMatchObject({
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
      await c.place(member("a", 0, story));
      expect(await c.place(member("b", 1, grey))).toMatchObject({ isNew: true, method: "NEW" });
    });

    it("sender opptil tre kandidatsaker, mest lik først", async () => {
      const judge = vi.fn<StoryJudge>(async () => ({ match: "B", reason: "" }));
      const c = clusterer(judge);
      // Fire saker som ikke ligner hverandre, men alle ligner det nye elementet litt.
      const s1 = await c.place(member("s1", 0, { p: 1, q: 3 }));
      await c.place(member("s2", 0, { p: 1, r: 2 }));
      await c.place(member("s3", 0, { p: 1, s: 4 }));
      await c.place(member("s4", 0, { p: 1, t: 5 }));
      const placed = await c.place(member("ny", 1, { p: 1, u: 1 }));
      const candidates = judge.mock.calls[0][1];
      expect(candidates.map((cand) => cand.items[0].title)).toEqual(["s2", "s1", "s3"]);
      // «B» er den nest mest like saken.
      expect(placed.story).toBe(s1.story);
    });

    it("stopper å spørre når grensen for antall kall er nådd", async () => {
      const judge = vi.fn<StoryJudge>(async () => ({ match: "A", reason: "" }));
      const c = clusterer(judge, 1);
      await c.place(member("a", 0, story));
      await c.place(member("b", 1, grey));
      const third = await c.place(member("c", 2, { flom: 1, k: 1, l: 1, m: 1, n: 1, o: 1, p: 1, q: 1, r: 1 }));
      expect(judge).toHaveBeenCalledTimes(1);
      expect(third.method).not.toBe("CLAUDE");
    });
  });

  it("tar bare med saker innenfor tidsvinduet", async () => {
    const c = clusterer();
    await c.place(member("a", 0, { flom: 1 }));
    const late = await c.place(member("b", 73, { flom: 1 }));
    expect(late).toMatchObject({ isNew: true, score: null });
    // Vinduet regnes fra sakens siste kilde, så en sak som fortsetter å få kilder holder seg åpen.
    const c2 = clusterer();
    const first = await c2.place(member("a", 0, { flom: 1 }));
    await c2.place(member("b", 60, { flom: 1 }));
    expect((await c2.place(member("c", 120, { flom: 1 }))).story).toBe(first.story);
  });

  it("sammenligner med det mest like elementet i saken", async () => {
    const c = clusterer();
    const first = await c.place(member("a", 0, { vind: 1, more: 1 }));
    await c.place(member("b", 1, { vind: 1, more: 1, ferje: 1, stengt: 1 }));
    // Ligner bare det andre elementet nok.
    const placed = await c.place(member("c", 2, { ferje: 1, stengt: 1, vind: 1 }));
    expect(placed.story).toBe(first.story);
  });

  it("kan angre en plassering som ikke ble lagret", async () => {
    const c = clusterer();
    const m = member("a", 0, { flom: 1 });
    const placed = await c.place(m);
    c.retract(m, placed);
    expect(c.stories).toHaveLength(0);
  });
});
