import type { ClusteringConfig } from "../config/schema";
import type { ClustererOptions, StoryJudge } from "./assign";

const HOUR_MS = 60 * 60 * 1000;

/** Innstillingene for grupperingen slik de står i config/site.config.ts. */
export function clustererOptions(
  settings: ClusteringConfig,
  judge: StoryJudge | null,
  maxJudgeCalls: number = settings.maxClaudeChecksPerRun,
): ClustererOptions {
  return {
    windowMs: settings.storyWindowHours * HOUR_MS,
    maxStoryMs: settings.maxStoryHours * HOUR_MS,
    sameStoryThreshold: settings.sameStoryThreshold,
    borderlineThreshold: settings.borderlineThreshold,
    judge,
    maxJudgeCalls,
  };
}
