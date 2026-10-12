import rawConfig from "@config/site.config";
import { parseSiteConfig } from "./schema";

/** Validert konfigurasjon. Kaster ved import hvis config/site.config.ts er ugyldig. */
export const siteConfig = parseSiteConfig(rawConfig);

export type { SiteConfig, SourceConfig } from "./schema";
