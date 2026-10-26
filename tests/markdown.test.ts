import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleBody } from "@/components/article-body";
import { parseBody } from "@/lib/markdown";

describe("brødtekst i Markdown", () => {
  it("gjør om avsnitt, mellomtitler og punktlister", () => {
    expect(parseBody("## Bakgrunn\n\nFørste avsnitt\nsom fortsetter.\n\n- én\n* to\n\nSiste.")).toEqual([
      { type: "heading", text: "Bakgrunn" },
      { type: "paragraph", text: "Første avsnitt som fortsetter." },
      { type: "list", items: ["én", "to"] },
      { type: "paragraph", text: "Siste." },
    ]);
  });

  it("fjerner tegn for utheving, men ikke stjerner i vanlig tekst", () => {
    expect(parseBody("Et **viktig** og *lite* ord, men 2 * 3 er 6.")).toEqual([
      { type: "paragraph", text: "Et viktig og lite ord, men 2 * 3 er 6." },
    ]);
  });

  it("lar HTML og lenker være vanlig tekst (React escaper den)", () => {
    expect(parseBody("<script>alert(1)</script> [lenke](https://example.no)")).toEqual([
      { type: "paragraph", text: "<script>alert(1)</script> [lenke](https://example.no)" },
    ]);
  });

  it("håndterer Windows-linjeskift og tomme blokker", () => {
    expect(parseBody("Første.\r\n\r\n\r\n\r\nAndre.\n\n   \n")).toEqual([
      { type: "paragraph", text: "Første." },
      { type: "paragraph", text: "Andre." },
    ]);
  });

  it("tolker mellomtitler og lister også uten tom linje før eller etter", () => {
    expect(parseBody("Innledning.\n## Bakgrunn\nRegjeringen opplyser at\n- én\n- to\n\nSiste linje.")).toEqual([
      { type: "paragraph", text: "Innledning." },
      { type: "heading", text: "Bakgrunn" },
      { type: "paragraph", text: "Regjeringen opplyser at" },
      { type: "list", items: ["én", "to"] },
      { type: "paragraph", text: "Siste linje." },
    ]);
  });

  it("tolker nummererte lister og lar en linje rett etter et punkt høre til punktet", () => {
    expect(parseBody("Tiltakene er:\n\n1. Stenge veien.\n2. Varsle beboerne\nsom bor nær elva.")).toEqual([
      { type: "paragraph", text: "Tiltakene er:" },
      { type: "list", ordered: true, items: ["Stenge veien.", "Varsle beboerne som bor nær elva."] },
    ]);
    expect(parseBody("- Første punkt som\n  fortsetter her\n- Andre punkt")).toEqual([
      { type: "list", items: ["Første punkt som fortsetter her", "Andre punkt"] },
    ]);
  });

  it("lar et tall først på en linje midt i et avsnitt være vanlig tekst", () => {
    expect(parseBody("Fristen er utsatt fra mai\n2. juni er ny frist.")).toEqual([
      { type: "paragraph", text: "Fristen er utsatt fra mai 2. juni er ny frist." },
    ]);
  });

  it("lar et avsnitt som starter med en dato, være et avsnitt", () => {
    expect(
      parseBody(
        "Innledning.\n\n8. oktober ble det kjent.\nFylket ba om mer.\n\n## Bakgrunn\n22. juli 2011 skjedde det.",
      ),
    ).toEqual([
      { type: "paragraph", text: "Innledning." },
      { type: "paragraph", text: "8. oktober ble det kjent. Fylket ba om mer." },
      { type: "heading", text: "Bakgrunn" },
      { type: "paragraph", text: "22. juli 2011 skjedde det." },
    ]);
    expect(parseBody("8. Oktober ble det kjent.")).toEqual([{ type: "paragraph", text: "8. Oktober ble det kjent." }]);
  });

  it("beholder nummeret en liste starter på", () => {
    expect(parseBody("3. Tredje\n4. Fjerde")).toEqual([
      { type: "list", ordered: true, start: 3, items: ["Tredje", "Fjerde"] },
    ]);
    expect(renderToStaticMarkup(createElement(ArticleBody, { body: "3. Tredje" }))).toContain('<ol start="3"');
  });

  it("viser nummererte lister som <ol>", () => {
    expect(renderToStaticMarkup(createElement(ArticleBody, { body: "1. Én\n2. To" }))).toContain(
      '<ol class="list-decimal space-y-1 pl-6"><li>Én</li><li>To</li></ol>',
    );
  });

  it("gir mellomtitlene nivået som passer der teksten vises", () => {
    const body = "## Bakgrunn\n\nTekst.";
    expect(renderToStaticMarkup(createElement(ArticleBody, { body }))).toContain("<h2");
    expect(renderToStaticMarkup(createElement(ArticleBody, { body, headingLevel: 4 }))).toContain("<h4");
  });
});
