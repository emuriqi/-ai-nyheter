import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export type Prompt = {
  name: string;
  text: string;
  /** Kort hash av teksten. Lagres sammen med resultatet, så vi vet hvilken versjon som ble brukt. */
  version: string;
};

const cache = new Map<string, Prompt>();

/**
 * Leser en prompt fra mappen prompts/. Promptene ligger i egne filer så de er
 * lette å lese og endre uten å røre koden.
 */
export function loadPrompt(name: string): Prompt {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Ugyldig promptnavn: ${name}`);
  const cached = cache.get(name);
  if (cached) return cached;
  const text = readFileSync(path.join(process.cwd(), "prompts", `${name}.md`), "utf8").trim();
  const version = `${name}@${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  const prompt = { name, text, version };
  cache.set(name, prompt);
  return prompt;
}
