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

  it("feiler tydelig når formatet er uventet", () => {
    expect(() => parseStortingetSaker('{"noe_annet": []}')).toThrow("mangler saker_liste");
    expect(() => parseStortingetSaker("ikke json")).toThrow("ikke gyldig JSON");
  });
});
