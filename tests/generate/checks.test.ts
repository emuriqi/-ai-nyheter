import { describe, expect, it } from "vitest";
import { checkArticle, findQuotes, numbersIn, words } from "@/lib/generate/checks";
import type { WrittenArticle } from "@/lib/generate/schema";
import type { PreparedSource } from "@/lib/generate/sources";
import { parseSiteConfig } from "@/lib/config/schema";
import { loadGeneratedArticles } from "../helpers/generated-articles";
import { validConfig } from "../helpers/fixtures";

const editorial = parseSiteConfig(validConfig()).editorial;
const saker = loadGeneratedArticles();

/** Hvilke kontroller som skal slå ut for hver innplantet feil. */
const EXPECTED: Record<string, { kind: string; severity: string }[]> = {
  tall_uten_kilde: [{ kind: "tall_uten_kilde", severity: "middels" }],
  langt_sitat: [{ kind: "sitat_for_langt", severity: "blokkerer" }],
  oppdiktet_sitat: [{ kind: "sitat_ikke_i_kilde", severity: "blokkerer" }],
  kopiert_tekst: [{ kind: "kopiert_tekst", severity: "blokkerer" }],
  privatperson: [{ kind: "privatperson", severity: "blokkerer" }],
};

describe("automatiske kontroller på syntetiske artikler", () => {
  it.each(saker.map((s) => [s.event, s]))("den gode artikkelen om %s har ingen funn", (_event, sak) => {
    expect(checkArticle(sak.good, sak.sources, editorial)).toEqual([]);
  });

  const variants = saker.flatMap((s) => s.variants.map((v) => [s.event, v.feil, s, v] as const));
  it.each(variants)("%s: fanger innplantet %s", (_event, feil, sak, variant) => {
    const findings = checkArticle(variant.artikkel, sak.sources, editorial);
    for (const expected of EXPECTED[feil]) {
      expect(findings).toContainEqual(expect.objectContaining(expected));
    }
    // Privatperson-variantene har også en oppdiktet alder; ellers skal ingenting annet slå ut.
    const other = findings.filter(
      (f) =>
        !EXPECTED[feil].some((e) => e.kind === f.kind) && !(feil === "privatperson" && f.kind === "tall_uten_kilde"),
    );
    expect(other).toEqual([]);
  });
});

const source = (text: string, key = "K1"): PreparedSource => ({
  key,
  itemId: `id-${key}`,
  publisher: "NVE",
  title: "Flomvarsel",
  url: "https://example.no/1",
  publishedAt: new Date("2026-10-07T12:00:00Z"),
  text,
});

const article = (overrides: Partial<WrittenArticle> = {}): WrittenArticle => ({
  tittel: "Flomvarsel for Agder",
  ingress: "NVE varsler flom i Agder torsdag.",
  brodtekst: Array(12).fill("Beredskapen er styrket flere steder etter varselet fra etaten.").join(" "),
  kategori: "vær og klima",
  sensitive_temaer: [],
  personer: [],
  kilder_brukt: ["K1"],
  usikkerhet: [],
  ...overrides,
});

const SOURCE_TEXT =
  "NVE har sendt ut oransje farevarsel for flom i Agder torsdag. Det ventes 60–90 mm på 24 timer. " +
  "Vannstanden stiger i flere elver i fylket, opplyser direktoratet. Over 20 000 husstander kan bli berørt, og 4,6 prosent av veiene kan stenges.";

describe("enkeltkontroller", () => {
  it("finner tall og normaliserer tusenskille og desimalkomma", () => {
    expect(numbersIn("Over 20 000 husstander, 4,6 prosent, kl. 08 og 2026–2027")).toEqual([
      "20000",
      "4.6",
      "8",
      "2026",
      "2027",
    ]);
  });

  it("godtar tall fra kildene og fra publiseringsdatoen, men ikke andre", () => {
    const findings = checkArticle(
      article({
        ingress: "Over 20 000 husstander og 4,6 prosent av veiene, melder NVE 7. oktober. 35 skoler stenger.",
      }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(findings.filter((f) => f.kind === "tall_uten_kilde").map((f) => f.excerpt)).toEqual(["35"]);
  });

  it("finner sitater i alle vanlige anførselstegn", () => {
    expect(findQuotes('«Første», “andre” og "tredje" sitat')).toEqual(["Første", "andre", "tredje"]);
  });

  it("godtar korte, ordrette sitater, og merker korte uttrykk som ikke står i kilden som noe å sjekke", () => {
    const ok = checkArticle(
      article({ ingress: "Vannstanden «stiger i flere elver i fylket», opplyser direktoratet." }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(ok).toEqual([]);
    const short = checkArticle(
      article({ ingress: "Det er «svært alvorlig», sier NVE." }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(short).toEqual([expect.objectContaining({ kind: "sitat_ikke_i_kilde", severity: "middels" })]);
  });

  it("regner ikke et ordrett sitat som kopiert tekst, men en kopi utenfor sitatet", () => {
    const quoted = "«NVE har sendt ut oransje farevarsel for flom i Agder torsdag»";
    expect(
      checkArticle(article({ ingress: `${quoted}, skriver NVE.` }), [source(SOURCE_TEXT)], editorial).map(
        (f) => f.kind,
      ),
    ).toEqual([]);
    const copied = checkArticle(
      article({
        ingress:
          "Som kjent har NVE sendt ut oransje farevarsel for flom i Agder torsdag. Det ventes 60–90 mm på 24 timer.",
      }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(copied).toEqual([
      expect.objectContaining({
        kind: "kopiert_tekst",
        severity: "blokkerer",
        excerpt: "sendt ut oransje farevarsel for flom i agder torsdag det ventes 60 90 mm på 24 timer",
      }),
    ]);
  });

  it("tillater like ordrekker opp til grensen", () => {
    // 12 like ord på rad (grensen) er lov, 13 er ikke.
    const twelve = "NVE har sendt ut oransje farevarsel for flom i Agder torsdag. Det";
    expect(words(twelve)).toHaveLength(12);
    const atLimit = checkArticle(article({ ingress: twelve }), [source(SOURCE_TEXT)], editorial);
    expect(atLimit.filter((f) => f.kind === "kopiert_tekst")).toEqual([]);
    const over = checkArticle(article({ ingress: `${twelve} ventes` }), [source(SOURCE_TEXT)], editorial);
    expect(over.filter((f) => f.kind === "kopiert_tekst")).toHaveLength(1);
  });

  it("lar ikke en ordrekke gå fra ett felt til det neste", () => {
    const findings = checkArticle(
      article({
        tittel: "NVE har sendt ut oransje farevarsel",
        ingress: "for flom i Agder torsdag. Det ventes mye regn.",
      }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(findings.filter((f) => f.kind === "kopiert_tekst")).toEqual([]);
  });

  it("stopper ukjente kilder og privatpersoner, og merker personer med for få kilder", () => {
    const findings = checkArticle(
      article({
        kilder_brukt: ["K1", "K9"],
        personer: [
          { navn: "Ola Nordmann", rolle: "privatperson", kilder: ["K1"] },
          { navn: "Statsråden", rolle: "offentlig_person", kilder: ["K1"] },
          { navn: "Direktøren", rolle: "offentlig_person", kilder: ["K1", "K2"] },
        ],
      }),
      [source(SOURCE_TEXT), source("Direktøren sier noe.", "K2")],
      editorial,
    );
    expect(findings.map((f) => [f.kind, f.severity, f.excerpt])).toEqual([
      ["ukjent_kilde", "blokkerer", undefined],
      ["privatperson", "blokkerer", "Ola Nordmann"],
      ["personpåstand_med_for_få_kilder", "middels", "Statsråden"],
    ]);
  });

  it("merker artikler uten kilder, med lenker, HTML, kildehenvisninger og feil lengde", () => {
    const findings = checkArticle(
      article({
        tittel: "T".repeat(121),
        ingress: "Se https://example.no/flom og <b>dette</b> [K1].",
        brodtekst: "For kort.",
        kilder_brukt: [],
      }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(findings.map((f) => f.kind)).toEqual([
      "ingen_kilder",
      "lenke",
      "html",
      "kildehenvisning_i_teksten",
      "lengde",
      "lengde",
    ]);
  });
});
