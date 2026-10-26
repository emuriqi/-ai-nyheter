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
      "1200000",
    ]);
    // I en engelsk kilde er komma tusenskille og punktum desimaltegn.
    expect(numbersIn("around 4,600 jobs and 4.6 percent", { role: "kilde", language: "en" })).toEqual(["4600", "4.6"]);
  });

  // Kilden er publisert 1. september kl. 05.17 norsk tid, langt fra datoene og klokkeslettene i testene,
  // og hver form står bare én gang: i kilden eller i artikkelen.
  const far = (text: string, language = "nb") =>
    source(text, "K1", { publishedAt: new Date("2026-09-01T03:17:00Z"), language });
  it.each([
    [
      "dato med tall mot dato med ord",
      "Varselet gjelder fra 08.10.2026.",
      "Varselet gjelder fra 8. oktober.",
      "9. oktober",
    ],
    ["dato med ord mot dato uten år", "Fristen er 14. november.", "Fristen er 14.11.", "15.11."],
    ["dato i intervall", "Stengt fra 8. til 10. oktober.", "Stengt 8. oktober og 10. oktober.", "11. oktober"],
    ["engelsk dato", "Open until 31 December 2030.", "Åpent til 31. desember 2030.", "30. desember 2030", "en"],
    ["klokkeslett med kolon mot klokken", "Fra kl. 06:00.", "Fra klokken 06.", "klokken 07"],
    ["klokka mot kl.", "Neste publisering er klokka 08.30.", "Neste publisering er kl. 08.30.", "kl. 08.45"],
    ["klokkeslett uten kl.", "Møtet starter 10.15.", "Møtet starter kl. 10.15.", "kl. 10.20"],
    ["tusenskille", "Det gjelder 3 250 husstander.", "Det gjelder 3.250 husstander.", "3.260 husstander"],
    ["millioner", "Prisen er 1 200 000 kroner.", "Prisen er 1,2 millioner kroner.", "1,3 millioner kroner"],
    ["millioner omvendt", "Prisen er 1,2 millioner kroner.", "Prisen er 1 200 000 kroner.", "1 300 000 kroner"],
    ["en milliard", "Det koster 1 milliard kroner.", "Det koster en milliard kroner.", "en million kroner"],
    ["skoleår", "Gjelder skoleåret 2026/2027.", "Gjelder skoleåret 2026/27.", "2028/29"],
    ["tallord", "Tre personer er evakuert.", "3 personer er evakuert.", "4 personer"],
    ["engelsk tallord", "Three regions are affected.", "Tre regioner er berørt.", "Fire regioner", "en"],
    ["engelsk tusenskille", "Around 4,600 jobs.", "Rundt 4600 jobber.", "4700 jobber", "en"],
  ])("godtar %s, men ikke et annet tall", (_name, sourceText, same, other, language = "nb") => {
    const sources = [far(sourceText, language)];
    expect(of(checkArticle(article({ ingress: same }), sources, editorial), "tall_uten_kilde")).toEqual([]);
    expect(
      of(checkArticle(article({ ingress: `${same} Også ${other}.` }), sources, editorial), "tall_uten_kilde"),
    ).toHaveLength(1);
  });

  it("krever at et tall med skalaord har samme størrelse som i kilden", () => {
    const sources = [far("Prosjektet koster 3 millioner kroner og gjelder 20 husstander.")];
    for (const wrong of ["3 milliarder kroner", "3 mrd. kroner", "20 tusen husstander"]) {
      expect(
        of(checkArticle(article({ ingress: `Det gjelder ${wrong}.` }), sources, editorial), "tall_uten_kilde"),
      ).toHaveLength(1);
    }
    expect(
      of(checkArticle(article({ ingress: "Det koster 3 millioner kroner." }), sources, editorial), "tall_uten_kilde"),
    ).toEqual([]);
  });

  it("regner ikke «tre i kraft» og «et tre» som tallet tre", () => {
    const sources = [far("Endringene trer i kraft 1. januar 2027. Et tre falt over veien.")];
    const findings = checkArticle(
      article({ ingress: "Endringene skal tre i kraft 1. januar 2027, og et tre falt over veien." }),
      sources,
      editorial,
    );
    expect(of(findings, "tall_uten_kilde")).toEqual([]);
  });

  it("godtar klokkeslettet kilden ble publisert, i norsk tid", () => {
    // 07.00 UTC er 09.00 norsk sommertid.
    const sources = [source("Farevarselet er sendt ut.", "K1", { publishedAt: new Date("2026-09-01T07:00:00Z") })];
    expect(
      of(checkArticle(article({ ingress: "Varselet kom kl. 9." }), sources, editorial), "tall_uten_kilde"),
    ).toEqual([]);
    expect(
      of(checkArticle(article({ ingress: "Varselet kom kl. 7." }), sources, editorial), "tall_uten_kilde"),
    ).toEqual([["middels", "kl. 7"]]);
  });

  it("regner dagen før og etter i kalenderdager når sommertiden skifter", () => {
    // Søndag 25. oktober 2026 kl. 00.30 sommertid (vintertid fra kl. 03).
    const dst = [source("Varselet gjelder i morgen.", "K1", { publishedAt: new Date("2026-10-24T22:30:00Z") })];
    expect(
      of(checkArticle(article({ ingress: "Varselet gjelder 26. oktober." }), dst, editorial), "tall_uten_kilde"),
    ).toEqual([]);
    expect(
      of(checkArticle(article({ ingress: "Varselet gjelder 23. oktober." }), dst, editorial), "tall_uten_kilde"),
    ).toHaveLength(1);
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

  it("kjenner igjen vanlige måter å nevne den som siteres, etter sitatstrek", () => {
    const sources = [source("– Vi har fått svært mange henvendelser fra innbyggere i hele fylket, sier hun.")];
    for (const attribution of [
      ", forklarer hun.",
      ", konstaterer hun.",
      ", heter det i meldingen.",
      ". Det sier hydrolog Ola Hansen.",
    ]) {
      const body = `${article().brodtekst}\n\n– Vi har fått svært mange henvendelser fra innbyggere i hele fylket${attribution}`;
      expect(of(checkArticle(article({ brodtekst: body }), sources, editorial), "sitat_ikke_i_kilde")).toEqual([]);
    }
  });

  it("kontrollerer hele sitatet når det har et sitat i seg", () => {
    const sources = [source("«Vi kaller det «krise» her», sier hydrologen.")];
    const invented = checkArticle(
      article({ ingress: "«Vi kaller det «krise» og vil evakuere hele Agder umiddelbart i natt», sier hydrologen." }),
      sources,
      editorial,
    );
    expect(of(invented, "sitat_ikke_i_kilde").map(([severity]) => severity)).toEqual(["blokkerer"]);
    const verbatim = checkArticle(
      article({ ingress: "«Vi kaller det «krise» her», sier hydrologen." }),
      sources,
      editorial,
    );
    expect(verbatim).toEqual([]);
  });

  it("godtar utelatelser og innskudd som ordrette, men ber redaktøren sjekke meningen", () => {
    const sources = [source(QUOTE_SOURCE)];
    for (const gap of ["[…]", "(…)", "…"]) {
      const findings = checkArticle(
        article({ ingress: `«Vi er svært bekymret ${gap} vi ber folk om å holde seg unna elvebredden», sier NVE.` }),
        sources,
        editorial,
      );
      expect(findings.map((f) => [f.kind, f.severity])).toEqual([["sitat_forkortet", "middels"]]);
    }
    const insertion = checkArticle(
      article({ ingress: "«Vi er svært bekymret for situasjonen i de små vassdragene [i Agder]», sier NVE." }),
      sources,
      editorial,
    );
    expect(insertion.map((f) => [f.kind, f.severity])).toEqual([["sitat_med_innskudd", "middels"]]);
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

describe("kopiert tittel i flere kilder", () => {
  it("gir samme resultat uansett rekkefølgen på kildene", () => {
    const title =
      "Endringer i lov om barnehager for å redusere maksimalprisen for foreldrebetaling i barnehager fra høsten";
    const k1 = source("Proposisjonen er lagt fram.", "K1", { title });
    const k2 = source(`Stortinget har fått saken «${title}» til behandling.`, "K2", { title: "Ny sak i Stortinget" });
    const ingress = `Stortinget behandler ${title}.`;
    for (const sources of [
      [k1, k2],
      [k2, k1],
    ]) {
      expect(of(checkArticle(article({ ingress }), sources, editorial), "kopiert_tekst").map(([sev]) => sev)).toEqual([
        "høy",
      ]);
    }
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

  it("stopper en privatperson som navngis i genitiv, med bare etternavn eller med tillegg i navnet", () => {
    const sources = [source("Kari Nilsen måtte forlate huset i Vennesla.")];
    for (const [ingress, navn] of [
      ["Kari Nilsens hus i Vennesla ble tatt av flommen.", "Kari Nilsen"],
      ["Nilsen måtte forlate huset sitt.", "Kari Nilsen"],
      ["Kari Nilsen måtte forlate huset.", "Kari Nilsen, Vennesla"],
    ]) {
      const findings = checkArticle(
        article({
          ingress,
          personer: [{ navn, rolle: "privatperson", omtale: "påstand_om_personen", kilder: ["K1"] }],
        }),
        sources,
        editorial,
      );
      expect(of(findings, "privatperson")).toEqual([["blokkerer", navn]]);
    }
  });

  it("regner ikke en beskrivelse med stor forbokstav som et navn", () => {
    const findings = checkArticle(
      article({
        ingress: "En mann i 40-årene er evakuert.",
        personer: [{ navn: "Mann i 40-årene", rolle: "privatperson", omtale: "påstand_om_personen", kilder: ["K1"] }],
      }),
      [source("En mann i 40-årene er evakuert.")],
      editorial,
    );
    expect(findings.map((f) => [f.kind, f.severity])).toEqual([["privatperson_omtalt", "middels"]]);
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

  it("regner ikke vanlige navn på institusjoner og områder som personer", () => {
    const ingress =
      "Helse Sør-Øst, Nordre Follo og Indre Østfold samarbeider med Røde Kors og Norsk Folkehjelp. Oslo Børs falt.";
    const findings = checkArticle(article({ ingress }), [source(ingress)], editorial);
    expect(of(findings, "navn_utenfor_personlisten")).toEqual([]);
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
    // Et parti i parentes eller et vanlig ord som etternavn er ikke nok til at en kilde nevner personen.
    const party = [
      source("Hydrolog Ola Hansen har ledet arbeidet."),
      source("Ap mener det.", "K2", { publisher: "Ap" }),
    ];
    const withParty = checkArticle(
      article({
        ingress: "Ola Hansen har ledet arbeidet.",
        personer: [
          { navn: "Ola Hansen (Ap)", rolle: "offentlig_person", omtale: "påstand_om_personen", kilder: ["K1", "K2"] },
        ],
      }),
      party,
      editorial,
    );
    expect(of(withParty, "personpåstand_med_for_få_kilder")).toHaveLength(1);
    const sand = [
      source("Ordfører Jon Sand har ledet arbeidet."),
      source("Det er lagt sand og grus på veiene.", "K2", { publisher: "Statens vegvesen" }),
    ];
    const withSand = checkArticle(
      article({
        ingress: "Ordfører Jon Sand har ledet arbeidet.",
        personer: [
          { navn: "Jon Sand", rolle: "offentlig_person", omtale: "påstand_om_personen", kilder: ["K1", "K2"] },
        ],
      }),
      sand,
      editorial,
    );
    expect(of(withSand, "personpåstand_med_for_få_kilder")).toHaveLength(1);
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

  it("fjerner også lister og intervaller, og merker nøkler som står igjen i teksten", () => {
    const { article: cleaned } = stripSourceRefs(
      article({ ingress: "Det ventes regn (K1 og K2). Flom [K1–K3]. Ras (kilde: K4). Vind [K1, K2 og K3]." }),
    );
    expect(cleaned.ingress).toBe("Det ventes regn. Flom. Ras. Vind.");
    const { findings } = stripSourceRefs(article({ ingress: "Ifølge K2 er det fare for flom." }));
    expect(findings).toEqual([
      expect.objectContaining({ kind: "kildehenvisning_i_teksten", severity: "middels", excerpt: "K2" }),
    ]);
  });
});
