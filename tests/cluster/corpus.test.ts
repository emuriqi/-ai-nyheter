import { describe, expect, it } from "vitest";
import { Clusterer, type StoryJudge } from "@/lib/cluster/assign";
import { siteConfig } from "@/lib/config";
import { loadCorpus, pairwiseScores, toMembers } from "../helpers/cluster-corpus";

/**
 * Kvalitet målt på det syntetiske korpuset i tests/fixtures/cluster-corpus.json:
 * 48 elementer om 19 oppdiktede hendelser, skrevet i sju ulike kildestiler,
 * med bevisst like hendelser (to farevarsler samme dag, to utbrudd av
 * fugleinfluensa, to lovforslag fra samme departement).
 */
const items = loadCorpus();
const members = toMembers(items);
const truth = new Map(items.map((item) => [item.id, item.event]));
const eventById = new Map(items.map((item) => [item.id, item.event]));
const { clustering } = siteConfig;

async function run(judge: StoryJudge | null) {
  const clusterer = new Clusterer({
    windowMs: clustering.storyWindowHours * 3600_000,
    sameStoryThreshold: clustering.sameStoryThreshold,
    borderlineThreshold: clustering.borderlineThreshold,
    judge,
    maxJudgeCalls: 100,
  });
  const predicted = new Map<string, string>();
  const storyIds = new Map<object, string>();
  for (const member of members) {
    const { story } = await clusterer.place(member);
    if (!storyIds.has(story)) storyIds.set(story, `s${storyIds.size}`);
    predicted.set(member.id, storyIds.get(story)!);
  }
  return { scores: pairwiseScores(truth, predicted), predicted, judgeCalls: clusterer.judgeCalls };
}

/** En dommer som kjenner fasiten. Viser hva gråsonen kan gi med en god vurdering. */
const textToId = new Map(members.map((m) => [m.text, m.id]));
const oracle: StoryJudge = async (item, candidates) => {
  const event = eventById.get(textToId.get(item)!);
  const hit = candidates.find((c) => c.items.some((text) => eventById.get(textToId.get(text)!) === event));
  return { match: hit ? hit.key : null, reason: "fasit" };
};

describe("gruppering på testkorpuset", () => {
  it("har korpuset som forventet", () => {
    expect(items).toHaveLength(48);
    expect(new Set(truth.values()).size).toBe(19);
  });

  it("slår aldri sammen ulike saker uten Claude (presisjon 1), og finner over halvparten av parene", async () => {
    const { scores } = await run(null);
    expect(scores.precision).toBe(1);
    expect(scores.recall).toBeGreaterThan(0.55);
  });

  it("skiller de vanskelige parene", async () => {
    const { predicted } = await run(null);
    const together = (a: string, b: string) => predicted.get(a) === predicted.get(b);
    // Fugleinfluensa i Rogaland og i Trøndelag
    expect(together("etat-07", "etat-09")).toBe(false);
    // To lovforslag fra Kunnskapsdepartementet, mottatt i Stortinget samme dag
    expect(together("stortinget-01", "stortinget-02")).toBe(false);
    // KPI for august og september (en måned imellom)
    expect(together("statistikk-04", "statistikk-02")).toBe(false);
    // Havvindstrategien og varselet om kuling ved Utsira
    expect(together("departement-05", "varsel-04")).toBe(false);
  });

  it("finner alle parene med en god vurdering i gråsonen, uten å blande saker", async () => {
    const { scores, judgeCalls } = await run(oracle);
    expect(scores.precision).toBe(1);
    expect(scores.recall).toBe(1);
    // Gråsonen er smal nok til at bare en tredjedel av elementene trenger en vurdering.
    expect(judgeCalls).toBeLessThanOrEqual(16);
  });

  it("faller tilbake til egne saker når vurderingen feiler", async () => {
    const failing: StoryJudge = async () => undefined;
    const withFailures = await run(failing);
    const without = await run(null);
    expect(withFailures.scores).toEqual(without.scores);
  });
});
