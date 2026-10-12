import { describe, expect, it } from "vitest";
import { FeedParseError, parseFeed } from "@/lib/ingest/feed";
import { parseStortingetDate, parseStortingetSaker, STORTINGET_SAK_URL } from "@/lib/ingest/stortinget";
import { fixture } from "../helpers/fake-fetch";

describe("parseFeed: RSS 2.0", () => {
  const items = parseFeed(fixture("rss2.xml"), "https://example.no/rss");

  it("hopper over elementer uten lenke", () => {
    expect(items.map((item) => item.guid)).toEqual(["sak-1", "sak-2", "sak-3", "https://example.no/sak/5"]);
  });

  it("gjør HTML om til ren tekst uten bilder og skript", () => {
    expect(items[0].summary).toBe("Eksempeltallet økte med 3 prosent & mer.");
  });

  it("leser datoer fra pubDate og dc:date, og ugyldige datoer blir null", () => {
    expect(items[0].publishedAt?.toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(items[1].publishedAt?.toISOString()).toBe("2026-10-11T12:00:00.000Z");
    expect(items[3].publishedAt).toBeNull();
  });

  it("tar med hele teksten fra content:encoded med avsnitt", () => {
    expect(items[1].content).toBe("Første avsnitt av hele teksten.\nAndre avsnitt.");
  });

  it("løser relative lenker og numeriske tegnreferanser", () => {
    expect(items[3].url).toBe("https://example.no/sak/5");
    expect(items[3].title).toBe("Sak med relativ lenke og åpen lisens");
  });
});

describe("parseFeed: Atom og RDF", () => {
  it("leser Atom med alternativ lenke, HTML-titler og innhold", () => {
    const [first, second] = parseFeed(fixture("atom.xml"), "https://example.no/atom");
    expect(first).toMatchObject({
      guid: "urn:uuid:entry-1",
      url: "https://example.no/atom/1",
      title: "Atom-sak med formatering",
      summary: "Sammendrag av saken.",
    });
    expect(second.publishedAt?.toISOString()).toBe("2026-10-10T07:00:00.000Z");
    expect(second.content).toBe("Hele innholdet.");
  });

  it("leser RSS 1.0 (RDF)", () => {
    const [item] = parseFeed(fixture("rdf.xml"), "https://example.no/rdf");
    expect(item).toMatchObject({ guid: "https://example.no/rdf/1", title: "RDF-sak", summary: "Beskrivelse." });
  });
});

describe("parseFeed: kanttilfeller", () => {
  const rss = (items: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`;

  it("dekoder numeriske tegnreferanser i lenker", () => {
    const [item] = parseFeed(rss("<item><title>A</title><link>https://example.no/?p=1&#038;lang=nb</link></item>"), "https://example.no/");
    expect(item.url).toBe("https://example.no/?p=1&lang=nb");
  });

  it("bruker guid som lenke når <link> mangler, men ikke når isPermaLink er false", () => {
    const items = parseFeed(
      rss(
        '<item><title>A</title><guid>https://example.no/sak/9</guid></item>' +
          '<item><title>B</title><guid isPermaLink="false">https://example.no/sak/10</guid></item>',
      ),
      "https://example.no/",
    );
    expect(items.map((item) => item.url)).toEqual(["https://example.no/sak/9"]);
  });

  it("leser Atom-titler med type xhtml og lar ren tekst være", () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Tittel <b>med</b> uthevet</div></title>
        <link href="https://example.no/1"/><id>1</id></entry>
      <entry><title type="text">Renten &lt;b&gt; er 5 &lt; 6</title><link href="https://example.no/2"/><id>2</id></entry>
    </feed>`;
    const [xhtml, plain] = parseFeed(atom, "https://example.no/");
    expect(xhtml.title).toBe("Tittel med uthevet");
    expect(plain.title).toBe("Renten <b> er 5 < 6");
  });

  it("avviser ikke feeden når «<!ENTITY» står som tekst i et element", () => {
    const items = parseFeed(
      rss("<item><title>XML</title><link>https://example.no/1</link><description><![CDATA[Om <!ENTITY i XML]]></description></item>"),
      "https://example.no/",
    );
    expect(items.map((item) => item.title)).toEqual(["XML"]);
  });

  it("forstår norske tidssoner (CET og CEST)", () => {
    const items = parseFeed(
      rss(
        "<item><title>A</title><link>https://example.no/1</link><pubDate>Mon, 12 Oct 2026 08:00:00 CEST</pubDate></item>" +
          "<item><title>B</title><link>https://example.no/2</link><pubDate>Mon, 12 Jan 2026 08:00:00 CET</pubDate></item>",
      ),
      "https://example.no/",
    );
    expect(items[0].publishedAt?.toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(items[1].publishedAt?.toISOString()).toBe("2026-01-12T07:00:00.000Z");
  });
});

describe("parseFeed: ugyldige feeder", () => {
  it("avviser ENTITY-deklarasjoner", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title></item></channel></rss>`;
    expect(() => parseFeed(evil, "https://example.no/")).toThrow(FeedParseError);
  });

  it("avviser ukjente formater", () => {
    expect(() => parseFeed("<html><body>Ikke en feed</body></html>", "https://example.no/")).toThrow(
      "Ukjent feed-format",
    );
  });
});

describe("Stortinget-adapteren", () => {
  const items = parseStortingetSaker(fixture("stortinget-saker.json"));

  it("leser saker og hopper over ugyldige", () => {
    expect(items.map((item) => item.guid)).toEqual(["99001", "99002"]);
  });

  it("lenker til saken på stortinget.no og samler fakta som tekst", () => {
    expect(items[0].url).toBe(`${STORTINGET_SAK_URL}99001`);
    expect(items[0].summary).toBe(
      [
        "Korttittel: Endringer i eksempelloven",
        "Status: til behandling",
        "Type: alminneligsak",
        "Dokumentgruppe: proposisjon",
        "Komité: Eksempelkomiteen",
        "Emner: Eksempelemne, Testing",
        "Henvisning: Prop. 1 L (2026-2027)",
      ].join("\n"),
    );
  });

  it("leser Microsofts datoformat og ISO 8601", () => {
    expect(parseStortingetDate("/Date(1791720000000+0200)/")?.toISOString()).toBe("2026-10-11T12:00:00.000Z");
    expect(parseStortingetDate("/Date(-23508000000+0200)/")?.getUTCFullYear()).toBe(1969);
    expect(items[1].publishedAt).not.toBeNull();
    expect(parseStortingetDate("tull")).toBeNull();
  });

  it("godtar tall i beskrivende felter, f.eks. statuskoder", () => {
    const [sak] = parseStortingetSaker(
      JSON.stringify({
        saker_liste: [{ id: 1, tittel: "Sak med koder", status: 2, type: 1, komite: { navn: 7 }, emne_liste: [{ navn: 3 }] }],
      }),
    );
    expect(sak.summary).toBe("Status: 2\nType: 1\nKomité: 7\nEmner: 3");
  });

  it("feiler tydelig når ingen saker kan leses", () => {
    expect(() => parseStortingetSaker(JSON.stringify({ saker_liste: [{ tittel: "uten id" }, { id: 2 }] }))).toThrow(
      "ingen av 2 saker kunne leses",
    );
    expect(parseStortingetSaker(JSON.stringify({ saker_liste: [] }))).toEqual([]);
  });

  it("feiler tydelig når formatet er uventet", () => {
    expect(() => parseStortingetSaker('{"noe_annet": []}')).toThrow("mangler saker_liste");
    expect(() => parseStortingetSaker("ikke json")).toThrow("ikke gyldig JSON");
  });
});
