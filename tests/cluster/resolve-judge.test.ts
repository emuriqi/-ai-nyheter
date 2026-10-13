import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveJudge, runClusterJob } from "@/lib/cluster/run";
import { clusterConfig } from "../helpers/cluster-db";
import { createTestDb } from "../helpers/test-db";

// Simulerer at Claude-dommeren ikke kan settes opp, for eksempel fordi promptfilen mangler.
vi.mock("@/lib/cluster/judge", () => ({
  createClaudeJudge: vi.fn(() => {
    throw new Error("ENOENT: prompts/cluster-same-story.md");
  }),
}));

describe("når Claude ikke kan settes opp", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("grupperer uten Claude i stedet for å feile, og jobben blir ikke hengende som RUNNING", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = clusterConfig({ useClaudeForBorderline: true });
    expect(resolveJudge(config, undefined)).toBeNull();
    expect(warn).toHaveBeenCalledWith("Grupperer uten Claude: ENOENT: prompts/cluster-same-story.md");

    const { db, cleanup } = createTestDb();
    try {
      const result = await runClusterJob(db, { config, trigger: "test" });
      expect(result.status).toBe("done");
      expect(await db.jobRun.findMany({ select: { status: true } })).toEqual([{ status: "SUCCEEDED" }]);
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });
});
