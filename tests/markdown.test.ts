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
    expect(parseBody("Innledning.\n## Bakgrunn\nRegjeringen opplyser at\n- én\n- to\nSiste linje.")).toEqual([
      { type: "paragraph", text: "Innledning." },
      { type: "heading", text: "Bakgrunn" },
      { type: "paragraph", text: "Regjeringen opplyser at" },
      { type: "list", items: ["én", "to"] },
      { type: "paragraph", text: "Siste linje." },
    ]);
  });

  it("gir mellomtitlene nivået som passer der teksten vises", () => {
    const body = "## Bakgrunn\n\nTekst.";
    expect(renderToStaticMarkup(createElement(ArticleBody, { body }))).toContain("<h2");
    expect(renderToStaticMarkup(createElement(ArticleBody, { body, headingLevel: 4 }))).toContain("<h4");
  });
});
