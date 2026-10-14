import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export type Prompt = {
  name: string;
  text: string;
  /** Kort hash av teksten som sendes. Lagres sammen med resultatet, så vi vet hvilken versjon som ble brukt. */
  version: string;
};

const cache = new Map<string, Prompt>();

/**
 * Leser en prompt fra mappen prompts/. Promptene ligger i egne filer så de er
 * lette å lese og endre uten å røre koden. Plassholdere som {{maxQuoteWords}}
 * fylles inn fra `vars` (verdier fra config/site.config.ts). Versjonen er en
 * hash av den ferdige teksten, så den endres også når en innstilling endres.
 */
export function loadPrompt(name: string, vars: Record<string, string | number> = {}): Prompt {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Ugyldig promptnavn: ${name}`);
  const key = `${name}:${JSON.stringify(Object.entries(vars).sort())}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const template = readFileSync(path.join(process.cwd(), "prompts", `${name}.md`), "utf8").trim();
  const text = template.replace(/\{\{(\w+)\}\}/g, (placeholder, variable: string) => {
    if (!(variable in vars)) throw new Error(`Prompten ${name} mangler verdi for ${placeholder}`);
    return String(vars[variable]);
  });
  const version = `${name}@${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  const prompt = { name, text, version };
  cache.set(key, prompt);
  return prompt;
}
