import { describe, expect, it } from "vitest";
import { manualErrorMessage } from "@/lib/cluster/manual";
import type { ClusterStats } from "@/lib/cluster/run";
import { describeCluster, describeClusterStats } from "@/lib/cluster/summary";
import { describeJobStats } from "@/lib/labels";

const base: ClusterStats = {
  considered: 0,
  newStories: 0,
  joined: 0,
  joinedByClaude: 0,
  newByClaude: 0,
  uncertain: 0,
  skipped: 0,
  claude: null,
  promptVersion: null,
};

describe("oppsummering av grupperingen", () => {
  it("beskriver en kjøring uten nye elementer", () => {
    expect(describeClusterStats(base)).toBe("ingen nye elementer");
  });

  it("bøyer entall og flertall", () => {
    expect(describeClusterStats({ ...base, considered: 1, newStories: 1, uncertain: 1 })).toBe(
      "1 element, 1 ny sak, 0 lagt til eksisterende saker, 1 usikker bør sjekkes i admin",
    );
    expect(
      describeClusterStats({ ...base, considered: 5, newStories: 2, newByClaude: 1, joined: 2, uncertain: 2 }),
    ).toBe("5 elementer, 3 nye saker, 2 lagt til eksisterende saker, 2 usikre bør sjekkes i admin");
  });

  it("tar med Claude, feil og elementer som ble hoppet over", () => {
    const stats: ClusterStats = {
      ...base,
      considered: 4,
      newStories: 1,
      joined: 1,
      joinedByClaude: 1,
      newByClaude: 1,
      skipped: 2,
      claude: { calls: 3, failures: 1, inputTokens: 900, outputTokens: 60 },
      promptVersion: "cluster-same-story@abc",
    };
    const text =
      "4 elementer, 2 nye saker, 2 lagt til eksisterende saker, Claude vurderte 3 (1 samme sak, 1 ny sak, 1 uten svar), " +
      "2 endret underveis og tas i neste kjøring";
    expect(describeClusterStats(stats)).toBe(text);
    // Admin leser statistikken fra jobbloggen (JSON).
    expect(describeJobStats("CLUSTER", JSON.parse(JSON.stringify(stats)))).toBe(text);
  });

  it("beskriver kjøringer som ble hoppet over eller feilet", () => {
    expect(describeCluster({ status: "skipped", reason: "En gruppering kjører allerede" })).toBe(
      "Gruppering hoppet over: En gruppering kjører allerede.",
    );
    expect(describeCluster({ status: "failed", reason: "disken er full" })).toBe(
      "Gruppering feilet: disken er full. Elementene grupperes i neste kjøring.",
    );
  });

  it("viser ingenting for ukjent statistikk", () => {
    expect(describeJobStats("CLUSTER", null)).toBe("");
    expect(describeJobStats("CLUSTER", { annet: 1 })).toBe("");
  });
});

describe("feilmeldinger i admin", () => {
  it("viser bare meldinger for kjente koder", () => {
    expect(manualErrorMessage("har-artikkel")).toBe(
      "Saken har en publisert artikkel, så kildene kan ikke flyttes her.",
    );
    expect(manualErrorMessage("Banken din er hacket, ring 12345678")).toBeNull();
    expect(manualErrorMessage("toString")).toBeNull();
    expect(manualErrorMessage(["har-artikkel"])).toBeNull();
    expect(manualErrorMessage(undefined)).toBeNull();
  });
});
