import type { SourceConfig } from "../config/schema";
import { parseFeed, type FeedItem } from "./feed";
import { parseStortingetSaker } from "./stortinget";

/** Hvordan en kilde leses. Valgt med `adapter` i config/site.config.ts. */
export type SourceAdapter = {
  accept: string;
  parse(body: string, feedUrl: string): FeedItem[];
};

export const ADAPTERS: Record<SourceConfig["adapter"], SourceAdapter> = {
  rss: {
    accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
    parse: parseFeed,
  },
  "stortinget-saker": {
    accept: "application/json",
    parse: (body) => parseStortingetSaker(body),
  },
};
