import { randomBytes, randomUUID } from "node:crypto";

/** Lengste slug. Lengre titler kuttes ved nærmeste bindestrek. */
const MAX_SLUG_CHARS = 60;

/**
 * Lager en lesbar adresse av en tittel: små bokstaver, æ → ae, ø → o, å → a
 * (vanlig i norske nettadresser), andre aksenter fjernes og alt annet blir
 * bindestreker.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= MAX_SLUG_CHARS) return slug || "sak";
  const cut = slug.slice(0, MAX_SLUG_CHARS + 1);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 20 ? cut.slice(0, lastDash) : slug.slice(0, MAX_SLUG_CHARS)).replace(/-+$/, "");
}

/**
 * Finner en ledig slug: først selve slugen, så med -2 til -20, og deretter
 * med et tilfeldig suffiks. Kaster aldri, så mange saker med samme tittel (for
 * eksempel faste farevarsler) ikke stopper grupperingen. `exists` sjekker
 * databasen.
 */
export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
  random: () => string = () => randomBytes(3).toString("hex"),
): Promise<string> {
  if (!(await exists(base))) return base;
  for (let n = 2; n <= 20; n++) {
    const candidate = `${base}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `${base}-${random()}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base}-${randomUUID()}`;
}
