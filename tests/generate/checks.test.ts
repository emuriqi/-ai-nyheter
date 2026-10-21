import { describe, expect, it } from "vitest";
import { checkArticle, findQuotes, numbersIn, stripSourceRefs, words } from "@/lib/generate/checks";
import { countWords } from "@/lib/generate/text";
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

const source = (text: string, key = "K1", extra: Partial<PreparedSource> = {}): PreparedSource => ({
  key,
  itemId: `id-${key}`,
  publisher: "NVE",
  title: "Flomvarsel",
  url: "https://example.no/1",
  publishedAt: new Date("2026-10-07T12:00:00Z"),
  language: "nb",
  text,
  truncated: false,
  ...extra,
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

const QUOTE_SOURCE =
  "– Vi er svært bekymret for situasjonen i de små vassdragene, og vi ber folk om å holde seg unna elvebredden, sier hydrologen. " +
  "Vannstanden ventes å nå toppen natt til fredag. Det er ikke meldt om skader så langt, opplyser NVE.";

/** Funnene av én type, som [alvor, utdrag]. */
const of = (findings: ReturnType<typeof checkArticle>, kind: string) =>
  findings.filter((f) => f.kind === kind).map((f) => [f.severity, f.excerpt]);

describe("tall, datoer og klokkeslett", () => {
  it("normaliserer tusenskille, desimaler, millioner og årstall", () => {
    expect(numbersIn("Over 20 000 husstander, 4,6 prosent, 3.250 kroner, 1,2 millioner og 2026/27")).toEqual([
      "2026",
      "2027",
      "20000",
      "4.6",
      "3250",
      "1.2",
    ]);
  });

  it("godtar samme tall skrevet på en annen måte", () => {
    const sources = [
      source(
        "Varselet gjelder fra 08.10.2026 kl. 06:00 til kl. 14:00. Tre personer er evakuert. " +
          "Det gjelder 3 250 husstander og 1 200 000 kroner i 2026/2027. Prisen er 1,2 millioner kroner.",
      ),
    ];
    const findings = checkArticle(
      article({
        ingress:
          "Varselet gjelder fra torsdag 8. oktober klokken 06 til klokken 14.00. 3 personer er evakuert fra 3.250 husstander.",
        brodtekst: `${article().brodtekst} Budsjettet for 2026/27 er 1,2 millioner kroner, og prisen er 1 200 000 kroner.`,
      }),
      sources,
      editorial,
    );
    expect(of(findings, "tall_uten_kilde")).toEqual([]);
  });

  it("finner oppdiktede tall skrevet med ord, og godtar ikke publiseringsdatoen som frie tall", () => {
    const sources = [source("Tre personer er evakuert.")];
    const words = checkArticle(
      article({ ingress: "Fire personer er evakuert, og tolv hus er tomme." }),
      sources,
      editorial,
    );
    expect(of(words, "tall_uten_kilde")).toEqual([
      ["middels", "Fire"],
      ["middels", "tolv"],
    ]);
    // Kilden er publisert 7. oktober (måned 10, dag 7).
    const digits = checkArticle(
      article({ ingress: "10 personer er evakuert og 7 hus er tatt av vannet." }),
      sources,
      editorial,
    );
    expect(of(digits, "tall_uten_kilde").map(([, e]) => e)).toEqual(["10", "7"]);
  });

  it("godtar datoer dagen før, samme dag og dagen etter at kilden ble publisert, i norsk tid", () => {
    // 22.30 UTC 7. oktober er 00.30 norsk tid 8. oktober.
    const sources = [source("Varselet gjelder fra i morgen.", "K1", { publishedAt: new Date("2026-10-07T22:30:00Z") })];
    const ok = checkArticle(
      article({
        ingress: "Varselet ble sendt 8. oktober og gjelder fra 9. oktober. Det kom etter et varsel 7. oktober.",
      }),
      sources,
      editorial,
    );
    expect(of(ok, "tall_uten_kilde")).toEqual([]);
    const late = checkArticle(article({ ingress: "Varselet gjelder fra 10. oktober 2026." }), sources, editorial);
    expect(of(late, "tall_uten_kilde")).toEqual([["middels", "10. oktober 2026"]]);
  });

  it("viser tallet slik det står i artikkelen", () => {
    const [finding] = checkArticle(
      article({ ingress: "Over 20.000 hus er berørt." }),
      [source("Hus er berørt.")],
      editorial,
    );
    expect(finding).toMatchObject({ kind: "tall_uten_kilde", excerpt: "20.000" });
    expect(finding.message).toContain("«20.000»");
  });
});

describe("sitater", () => {
  it("finner sitater i alle vanlige anførselstegn og med sitatstrek", () => {
    const text =
      '«Første», “andre”, „tredje“, ‹fjerde›, ‘femte’ og "sjette" sitat.\n\n– Vi er bekymret, sier hydrologen.';
    expect(findQuotes(text).map((q) => q.text)).toEqual([
      "Første",
      "andre",
      "tredje",
      "fjerde",
      "femte",
      "sjette",
      "Vi er bekymret",
    ]);
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

  it("kontrollerer sitater med sitatstrek og andre anførselstegn", () => {
    const sources = [source(QUOTE_SOURCE)];
    const dash = checkArticle(
      article({
        brodtekst: `${article().brodtekst}\n\n– Dette er den verste flommen vi har sett i Agder på over femti år, sier hydrologen.`,
      }),
      sources,
      editorial,
    );
    expect(of(dash, "sitat_ikke_i_kilde")).toEqual([
      ["blokkerer", "Dette er den verste flommen vi har sett i Agder på over femti år"],
    ]);
    const german = checkArticle(
      article({ ingress: "Hydrologen sier at „dette er den verste flommen på mange år“." }),
      sources,
      editorial,
    );
    expect(of(german, "sitat_ikke_i_kilde")).toHaveLength(1);
    // Et ordrett sitat med sitatstrek er ikke kopiert tekst.
    const verbatim = checkArticle(
      article({
        brodtekst: `${article().brodtekst}\n\n– Vi er svært bekymret for situasjonen i de små vassdragene, sier hydrologen.`,
      }),
      sources,
      editorial,
    );
    expect(verbatim).toEqual([]);
  });

  it("kontrollerer hver del av et sitat over flere avsnitt", () => {
    const sources = [source(QUOTE_SOURCE)];
    const invented = checkArticle(
      article({
        brodtekst:
          `${article().brodtekst}\n\n«Dette er den verste flommen vi har sett i Agder på over femti år.\n\n` +
          "«Vi ber folk om å holde seg unna elvebredden», sier hydrologen.",
      }),
      sources,
      editorial,
    );
    expect(of(invented, "sitat_ikke_i_kilde").map(([severity]) => severity)).toEqual(["blokkerer"]);
    const verbatim = checkArticle(
      article({
        brodtekst:
          `${article().brodtekst}\n\n«Vi er svært bekymret for situasjonen i de små vassdragene.\n\n` +
          "«Vi ber folk om å holde seg unna elvebredden», sier hydrologen.",
      }),
      sources,
      editorial,
    );
    expect(verbatim).toEqual([]);
  });

  it("godtar utelatelser med […] og (…), men merker innskudd i klammer", () => {
    const sources = [source(QUOTE_SOURCE)];
    for (const gap of ["[…]", "(…)", "…"]) {
      const findings = checkArticle(
        article({ ingress: `«Vi er svært bekymret ${gap} vi ber folk om å holde seg unna elvebredden», sier NVE.` }),
        sources,
        editorial,
      );
      expect(findings).toEqual([]);
    }
    const insertion = checkArticle(
      article({ ingress: "«Vi er svært bekymret for situasjonen i de små vassdragene [i Agder]», sier NVE." }),
      sources,
      editorial,
    );
    expect(insertion.map((f) => [f.kind, f.severity])).toEqual([["sitat_med_innskudd", "lav"]]);
    // Delene må stå i samme rekkefølge som i kilden.
    const reordered = checkArticle(
      article({ ingress: "«Vi ber folk om å holde seg unna elvebredden […] vi er svært bekymret», sier NVE." }),
      sources,
      editorial,
    );
    expect(of(reordered, "sitat_ikke_i_kilde")).toHaveLength(1);
  });

  it("har grensen for sitatlengde på nøyaktig maxQuoteWords ord", () => {
    const twentyOne = Array.from({ length: 21 }, (_, i) => `ord${i + 1}`);
    const sources = [source(`${twentyOne.join(" ")}.`)];
    const at = checkArticle(
      article({ ingress: `«${twentyOne.slice(0, 20).join(" ")}», sier NVE.` }),
      sources,
      editorial,
    );
    expect(of(at, "sitat_for_langt")).toEqual([]);
    const over = checkArticle(article({ ingress: `«${twentyOne.join(" ")}», sier NVE.` }), sources, editorial);
    expect(of(over, "sitat_for_langt").map(([severity]) => severity)).toEqual(["blokkerer"]);
  });

  it("blokkerer oppdiktede sitater fra fire ord, og flagger kortere", () => {
    const sources = [source(SOURCE_TEXT)];
    const three = checkArticle(article({ ingress: "«Helt uakseptabelt nå», sier NVE." }), sources, editorial);
    expect(of(three, "sitat_ikke_i_kilde").map(([severity]) => severity)).toEqual(["middels"]);
    const four = checkArticle(article({ ingress: "«Dette er helt uakseptabelt», sier NVE." }), sources, editorial);
    expect(of(four, "sitat_ikke_i_kilde").map(([severity]) => severity)).toEqual(["blokkerer"]);
  });

  it("godtar ikke et sitat som bare treffer en del av et ord i kilden", () => {
    const findings = checkArticle(
      article({ ingress: "NVE skriver at «veiene kan stenge 10»." }),
      [source("Over 100 av veiene kan stenge 100 steder.")],
      editorial,
    );
    expect(of(findings, "sitat_ikke_i_kilde")).toHaveLength(1);
  });

  it("teller ord slik en leser gjør", () => {
    expect(countWords("Vi venter 60–90 mm på 24 timer, og over 20 000 husstander i covid-19-lignende NVE-saker")).toBe(
      14,
    );
    const quote =
      "«Vi venter 60–90 mm på 24 timer, og over 20 000 husstander i Agder kan bli berørt av covid-19-lignende stengninger nå»";
    expect(countWords(quote)).toBe(20);
    const findings = checkArticle(article({ ingress: `${quote}, sier NVE.` }), [source(quote.slice(1, -1))], editorial);
    expect(of(findings, "sitat_for_langt")).toEqual([]);
  });

  it("ser bort fra myk bindestrek og tegn uten bredde i kildeteksten", () => {
    const findings = checkArticle(
      article({ ingress: "«Vi er svært bekymret for situasjonen», sier NVE." }),
      [source("Vi er svært bekym­ret for situa​sjonen i vassdragene.")],
      editorial,
    );
    expect(findings).toEqual([]);
  });

  it("merker et sitat som mangler avsluttende anførselstegn", () => {
    const findings = checkArticle(
      article({ ingress: "Hun sier «Vi er svært bekymret for situasjonen i de små vassdragene." }),
      [source(QUOTE_SOURCE)],
      editorial,
    );
    expect(findings.map((f) => [f.kind, f.severity])).toEqual([["sitattegn_mangler", "middels"]]);
  });

  it("setter en grense for hvor mye som siteres fra én kilde til sammen", () => {
    const quotes = [
      "«NVE har sendt ut oransje farevarsel for flom i Agder torsdag», skriver NVE.",
      "«Det ventes 60–90 mm på 24 timer», heter det.",
      "«Vannstanden stiger i flere elver i fylket», opplyser direktoratet.",
      "«Over 20 000 husstander kan bli berørt, og 4,6 prosent av veiene kan stenges», skriver NVE.",
    ];
    // Fire sitater på 10, 7, 7 og 14 ord: 38 ord fra samme kilde.
    const body = quotes.join("\n\n");
    const strict = { ...editorial, maxQuotedWordsPerSource: 30 };
    const findings = checkArticle(article({ brodtekst: body }), [source(SOURCE_TEXT)], strict);
    expect(findings.filter((f) => f.kind !== "lengde").map((f) => [f.kind, f.severity, f.message])).toEqual([
      ["for_mye_sitert", "høy", "Artikkelen siterer til sammen 38 ord ordrett fra K1. Grensen er 30."],
    ]);
    expect(
      checkArticle(article({ brodtekst: body }), [source(SOURCE_TEXT)], editorial).filter((f) => f.kind !== "lengde"),
    ).toEqual([]);
  });

  it("lar redaktøren vurdere oversatte sitater fra kilder på andre språk", () => {
    const english = source("“We must act now to protect our citizens,” said the President.", "K1", { language: "en" });
    const findings = checkArticle(
      article({ ingress: "«Vi må handle nå for å beskytte innbyggerne våre», sa kommisjonspresidenten." }),
      [english],
      editorial,
    );
    expect(of(findings, "sitat_ikke_i_kilde").map(([severity]) => severity)).toEqual(["høy"]);
  });
});

describe("kopiert tekst", () => {
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

  it("finner nesten kopierte avsnitt med små endringer", () => {
    const findings = checkArticle(
      article({
        brodtekst:
          "NVE har sendt ut oransje farevarsel for flom i Agder på torsdag. Det ventes 60–90 mm på 24 timer. " +
          "Vannstanden stiger i mange elver i fylket, opplyser direktoratet. Over 20 000 husstander kan bli rammet, " +
          "og 4,6 prosent av veiene kan stenges.",
      }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(findings.map((f) => [f.kind, f.severity])).toEqual([["nesten_kopiert", "høy"]]);
  });

  it("lar redaktøren vurdere lister med navn og kildens egen tittel", () => {
    const names =
      "Kristiansand, Vennesla, Lindesnes, Lyngdal, Farsund, Flekkefjord, Kvinesdal, Sirdal, Hægebostad, Åseral, Bygland, Valle og Bykle";
    const list = checkArticle(
      article({ ingress: `Varselet gjelder ${names}.` }),
      [source(`Berørte kommuner: ${names}.`)],
      editorial,
    );
    expect(of(list, "kopiert_tekst").map(([severity]) => severity)).toEqual(["høy"]);
    const title =
      "Endringer i lov om barnehager for å redusere maksimalprisen for foreldrebetaling i barnehager fra høsten";
    const sameTitle = checkArticle(
      article({ ingress: `Stortinget behandler ${title}.` }),
      [source("Saken er sendt til komiteen.", "K1", { title })],
      editorial,
    );
    expect(of(sameTitle, "kopiert_tekst").map(([severity]) => severity)).toEqual(["høy"]);
  });
});

describe("personer og kilder", () => {
  it("stopper ukjente kilder og navngitte privatpersoner", () => {
    const findings = checkArticle(
      article({
        ingress: "Ola Nordmann måtte forlate huset.",
        kilder_brukt: ["K1", "K9"],
        personer: [{ navn: "Ola Nordmann", rolle: "privatperson", omtale: "påstand_om_personen", kilder: ["K1"] }],
      }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(findings.map((f) => [f.kind, f.severity, f.excerpt])).toEqual([
      ["ukjent_kilde", "blokkerer", undefined],
      ["privatperson", "blokkerer", "Ola Nordmann"],
    ]);
  });

  it("blokkerer ikke en privatperson som er omtalt uten navn, men ber redaktøren sjekke", () => {
    const findings = checkArticle(
      article({
        ingress: "En mann i 40-årene er evakuert.",
        personer: [{ navn: "mann i 40-årene", rolle: "privatperson", omtale: "påstand_om_personen", kilder: ["K1"] }],
      }),
      [source("En mann i 40-årene er evakuert.")],
      editorial,
    );
    expect(findings.map((f) => [f.kind, f.severity])).toEqual([["privatperson_omtalt", "middels"]]);
  });

  it("finner navn som ikke står i personlisten", () => {
    const findings = checkArticle(
      article({
        ingress:
          "Hydrolog Ola Hansen i NVE er bekymret. Nabo Kari Nilsen måtte forlate huset. I Kristiansand og hos Norges Bank er det rolig.",
        personer: [{ navn: "Ola Hansen", rolle: "offentlig_person", omtale: "uttaler_seg", kilder: ["K1"] }],
      }),
      [source("Hydrolog Ola Hansen i NVE er bekymret. Kari Nilsen måtte forlate huset.")],
      editorial,
    );
    expect(of(findings, "navn_utenfor_personlisten")).toEqual([["middels", "Nabo Kari Nilsen"]]);
  });

  it("krever uavhengige kilder som nevner personen for påstander om personen", () => {
    const sources = [
      source("Hydrolog Ola Hansen sier at vannstanden stiger.", "K1"),
      source("Vannstanden stiger i Otra.", "K2", { publisher: "Meteorologisk institutt" }),
      source("Ola Hansen har ledet arbeidet.", "K3"),
      source("Ola Hansen har ledet arbeidet, opplyser kommunen.", "K4", { publisher: "Kristiansand kommune" }),
    ];
    const check = (omtale: "uttaler_seg" | "påstand_om_personen", kilder: string[]) =>
      of(
        checkArticle(
          article({
            ingress: "Ola Hansen har ledet arbeidet.",
            personer: [{ navn: "Ola Hansen", rolle: "offentlig_person", omtale, kilder }],
          }),
          sources,
          editorial,
        ),
        "personpåstand_med_for_få_kilder",
      );
    // K2 nevner ikke personen, og K1 og K3 har samme utgiver.
    expect(check("påstand_om_personen", ["K1", "K2"])).toEqual([["middels", "Ola Hansen"]]);
    expect(check("påstand_om_personen", ["K1", "K3"])).toEqual([["middels", "Ola Hansen"]]);
    expect(check("påstand_om_personen", ["K1", "K4"])).toEqual([]);
    // Det personen sier i sin rolle, er ikke en påstand om personen.
    expect(check("uttaler_seg", ["K1"])).toEqual([]);
  });
});

describe("form", () => {
  it("merker artikler uten kilder, med lenker, HTML og feil lengde", () => {
    const findings = checkArticle(
      article({
        tittel: "T".repeat(121),
        ingress: "Se https://example.no/flom og <b>dette</b>.",
        brodtekst: "For kort.",
        kilder_brukt: [],
      }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(findings.map((f) => [f.kind, f.severity])).toEqual([
      ["ingen_kilder", "høy"],
      ["lenke", "høy"],
      ["html", "høy"],
      ["lengde", "middels"],
      ["lengde", "middels"],
    ]);
  });

  it("finner lenker uten protokoll, og for lang ingress og brødtekst", () => {
    const www = checkArticle(article({ ingress: "Les mer på www.example.no/flom." }), [source(SOURCE_TEXT)], editorial);
    expect(www.map((f) => [f.kind, f.severity])).toEqual([["lenke", "høy"]]);
    const long = checkArticle(
      article({ ingress: "lang ".repeat(81), brodtekst: Array(1201).fill("ord").join(" ") }),
      [source(SOURCE_TEXT)],
      editorial,
    );
    expect(long.map((f) => [f.kind, f.message])).toEqual([
      ["lengde", "Ingressen har 405 tegn."],
      ["lengde", "Brødteksten har 1201 ord."],
    ]);
  });

  it("fjerner kildehenvisninger som [K1] fra teksten", () => {
    const { article: cleaned, findings } = stripSourceRefs(
      article({
        tittel: "Flom [K1]",
        ingress: "NVE varsler flom (K2).",
        brodtekst: "Det ventes regn [K1, K3]. Mer i morgen.",
      }),
    );
    expect([cleaned.tittel, cleaned.ingress, cleaned.brodtekst]).toEqual([
      "Flom",
      "NVE varsler flom.",
      "Det ventes regn. Mer i morgen.",
    ]);
    expect(findings).toEqual([expect.objectContaining({ kind: "kildehenvisning_i_teksten", severity: "lav" })]);
    expect(stripSourceRefs(article()).findings).toEqual([]);
  });
});
