import { describe, expect, it } from "vitest";
import { cosine, properNouns, TermStats, termFrequencies, tokenize, weigh } from "@/lib/cluster/features";
import { slugify, uniqueSlug } from "@/lib/cluster/slug";

describe("tokenize", () => {
  it("fjerner stoppord og stammer norske ord", () => {
    expect(tokenize("Regjeringen og regjeringa foreslår at farevarslene skal være kraftige")).toEqual([
      "regjering",
      "regjering",
      "foreslår",
      "farevarsl",
      "kraft",
    ]);
  });

  it("holder desimaltall samlet og dropper enkeltsifre", () => {
    expect(tokenize("Ledigheten steg til 4,6 prosent i 3 måneder av 2026")).toEqual([
      "led",
      "steg",
      "4.6",
      "prosent",
      "måned",
      "2026",
    ]);
  });

  it("beholder ord med tall i, som virusnavn", () => {
    expect(tokenize("H5N1 påvist")).toContain("h5n1");
  });

  it("fjerner ledetekster i faktalister, men beholder verdien", () => {
    expect(tokenize("Status: Til behandling\nKomité: Helse- og omsorgskomiteen")).toEqual([
      "behandling",
      "hels",
      "omsorgskomite",
    ]);
  });

  it("beholder starten av en tittel med kolon", () => {
    expect(tokenize("Fugleinfluensa i Klepp: nye prøver negative")).toEqual([
      "fugleinfluens",
      "klepp",
      "nye",
      "prøv",
      "negativ",
    ]);
  });

  it("ignorerer lenker", () => {
    expect(tokenize("Les mer på https://example.no/sak/123")).toEqual(["les", "mer"]);
  });
});

describe("properNouns", () => {
  it("finner navn midt i setninger, men ikke ord først i en setning", () => {
    expect(
      properNouns("Gult farevarsel for Møre og Romsdal. Mattilsynet har påvist H5N1 i Klepp (Rogaland) – NVE varsler."),
    ).toEqual(["Møre", "Romsdal", "H5N1", "Klepp", "Rogaland", "NVE"]);
  });

  it("teller ikke ord etter kolon eller linjeskift", () => {
    expect(properNouns("Ny strategi: Kortere behandling\nStatus: Mottatt")).toEqual([]);
  });
});

describe("TF-IDF og cosinuslikhet", () => {
  const a = termFrequencies({
    title: "Fugleinfluensa påvist i Klepp",
    excerpt: "Mattilsynet har opprettet soner.",
    bodyText: null,
  });
  const b = termFrequencies({ title: "Fugleinfluensa i Klepp: nye prøver negative", excerpt: null, bodyText: null });
  const c = termFrequencies({ title: "Boligprisene steg i tredje kvartal", excerpt: null, bodyText: null });
  const stats = new TermStats([a, b, c]);

  it("gir tittelen dobbel vekt og egennavn ekstra vekt", () => {
    // «Klepp» står i tittelen (2) og er et egennavn (2 til).
    expect(a.get("klepp")).toBe(4);
    expect(a.get("son")).toBe(1);
  });

  it("vekter sjeldne ord høyere enn vanlige", () => {
    expect(stats.idf("boligpris")).toBeGreaterThan(stats.idf("fugleinfluens"));
    expect(stats.idf("finnes-ikke")).toBeGreaterThan(stats.idf("boligpris"));
  });

  it("gir 1 for like tekster, 0 uten felles ord, og noe imellom ellers", () => {
    const va = weigh(a, stats);
    expect(cosine(va, va)).toBeCloseTo(1, 10);
    expect(cosine(va, weigh(c, stats))).toBe(0);
    const ab = cosine(va, weigh(b, stats));
    expect(ab).toBeGreaterThan(0.2);
    expect(ab).toBeLessThan(1);
  });

  it("håndterer tomme tekster", () => {
    const empty = weigh(termFrequencies({ title: "", excerpt: null, bodyText: null }), stats);
    expect(empty.size).toBe(0);
    expect(cosine(empty, weigh(a, stats))).toBe(0);
  });
});

describe("slugify", () => {
  it("lager lesbare norske adresser", () => {
    expect(slugify("Ørsta får 250 mill. til rassikring på fylkesveiene – «viktig»")).toBe(
      "orsta-far-250-mill-til-rassikring-pa-fylkesveiene-viktig",
    );
    expect(slugify("Kafé i Bærum")).toBe("kafe-i-baerum");
  });

  it("kutter lange titler ved en bindestrek", () => {
    const slug = slugify(
      "Representantforslag om å stanse videre tildeling av areal til havvind inntil konsekvensene er utredet",
    );
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toBe("representantforslag-om-a-stanse-videre-tildeling-av-areal");
  });

  it("gir «sak» når tittelen ikke har bokstaver eller tall", () => {
    expect(slugify("«»–!")).toBe("sak");
  });

  it("finner en ledig variant", async () => {
    const taken = new Set(["sak", "sak-2"]);
    expect(await uniqueSlug("sak", async (s) => taken.has(s))).toBe("sak-3");
    expect(await uniqueSlug("ny", async (s) => taken.has(s))).toBe("ny");
  });
});
