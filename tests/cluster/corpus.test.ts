import { describe, expect, it } from "vitest";
import type { StoryJudge } from "@/lib/cluster/assign";
import { clustererOptions } from "@/lib/cluster/options";
import { siteConfig } from "@/lib/config";
import { clusterCorpus, loadCorpus, oracleJudge, pairwiseScores, toMembers } from "../helpers/cluster-corpus";

/**
 * Kvalitet målt på det syntetiske korpuset, med innstillingene i
 * config/site.config.ts. Hovedkorpuset (tests/fixtures/cluster-corpus.json) har
 * 48 elementer om 19 oppdiktede hendelser i sju kildestiler, med bevisst like
 * hendelser (to farevarsler samme dag, to utbrudd av fugleinfluensa, to
 * lovforslag fra samme departement). Tillegget (cluster-corpus-hard.json) har
 * 18 elementer der sted, kilde eller form er lik, men hendelsen er en annen:
 * ulike farevarsler for samme fylke, to tilbakekallinger fra Mattilsynet, og
 * oppfølginger fra samme kilde.
 */
describe.each([
  { name: "hovedkorpuset", hard: false, items: 48, events: 19 },
  { name: "hovedkorpuset med vanskelige tilfeller", hard: true, items: 66, events: 28 },
])("gruppering på $name", ({ hard, items: itemCount, events }) => {
  const items = loadCorpus({ hard });
  const members = toMembers(items);
  const truth = new Map(items.map((item) => [item.id, item.event]));

  const run = (judge: StoryJudge | null) =>
    clusterCorpus(members, clustererOptions(siteConfig.clustering, judge, 1000));

  it("har korpuset som forventet", () => {
    expect(items).toHaveLength(itemCount);
    expect(new Set(truth.values()).size).toBe(events);
  });

  it("slår aldri sammen ulike saker uten Claude (presisjon 1), og finner minst halvparten av parene", async () => {
    const { predicted } = await run(null);
    const scores = pairwiseScores(truth, predicted);
    expect(scores.precision).toBe(1);
    expect(scores.recall).toBeGreaterThanOrEqual(0.5);
  });

  it("finner alle parene med en god vurdering i gråsonen, uten å blande saker", async () => {
    const { predicted, judgeCalls } = await run(oracleJudge(items, members));
    const scores = pairwiseScores(truth, predicted);
    expect(scores.precision).toBe(1);
    expect(scores.recall).toBe(1);
    // Under halvparten av elementene trenger en vurdering.
    expect(judgeCalls).toBeLessThan(items.length / 2);
  });

  it("faller tilbake til egne saker når vurderingen feiler", async () => {
    const failing = await run(async () => undefined);
    const without = await run(null);
    expect(failing.predicted).toEqual(without.predicted);
  });

  it("gir ikke lavere presisjon når dommeren alltid svarer «ingen»", async () => {
    const { predicted } = await run(async () => ({ match: null, reason: "" }));
    expect(pairwiseScores(truth, predicted).precision).toBe(1);
  });
});

describe("de vanskelige parene", () => {
  const items = loadCorpus({ hard: true });
  const members = toMembers(items);

  it("holdes adskilt uten Claude", async () => {
    const { predicted } = await clusterCorpus(members, clustererOptions(siteConfig.clustering, null, 0));
    const together = (a: string, b: string) => predicted.get(a) === predicted.get(b);
    // Fugleinfluensa i Rogaland og i Trøndelag
    expect(together("etat-07", "etat-09")).toBe(false);
    // To lovforslag fra Kunnskapsdepartementet, mottatt i Stortinget samme dag
    expect(together("stortinget-01", "stortinget-02")).toBe(false);
    // KPI for august og september (en måned imellom)
    expect(together("statistikk-04", "statistikk-02")).toBe(false);
    // Havvindstrategien og varselet om kuling ved Utsira
    expect(together("departement-05", "varsel-04")).toBe(false);
    // Vind, regn og snø i Møre og Romsdal, og et nytt vindvarsel uken etter
    expect(together("varsel-02", "hard-byraa-01")).toBe(false);
    expect(together("hard-varsel-01", "hard-varsel-02")).toBe(false);
    expect(together("varsel-01", "hard-varsel-03")).toBe(false);
    // To ulike tilbakekallinger fra Mattilsynet
    expect(together("hard-etat-05", "hard-etat-07")).toBe(false);
    // Utenrikshandel og KPI fra SSB samme morgen
    expect(together("hard-statistikk-01", "statistikk-02")).toBe(false);
  });
});
