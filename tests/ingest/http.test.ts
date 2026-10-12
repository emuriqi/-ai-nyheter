import { describe, expect, it } from "vitest";
import { AccessDeniedError, FetchError, politeFetch } from "@/lib/ingest/http";
import { createFakeFetch } from "../helpers/fake-fetch";

const base = { userAgent: "AI-nyheter/0.2 (+https://example.no/kontakt)", timeoutMs: 1000, maxBytes: 100 };

describe("politeFetch", () => {
  it("sender identifiserende User-Agent", async () => {
    const fake = createFakeFetch({ "https://example.no/rss": new Response("ok") });
    await politeFetch("https://example.no/rss", { ...base, fetchImpl: fake.fetchImpl });
    expect(fake.calls[0].headers["user-agent"]).toBe(base.userAgent);
  });

  it("godtar bare https", async () => {
    await expect(politeFetch("http://example.no/rss", base)).rejects.toThrow("Bare https");
  });

  it("følger omdirigeringer på samme vert, men ikke til andre verter", async () => {
    const fake = createFakeFetch({
      "https://example.no/gammel": new Response(null, { status: 301, headers: { location: "/ny" } }),
      "https://example.no/ny": new Response("innhold"),
      "https://example.no/ut": new Response(null, { status: 302, headers: { location: "https://annen.no/" } }),
    });
    const result = await politeFetch("https://example.no/gammel", { ...base, fetchImpl: fake.fetchImpl });
    expect(result).toMatchObject({ status: 200, url: "https://example.no/ny", body: "innhold" });

    await expect(politeFetch("https://example.no/ut", { ...base, fetchImpl: fake.fetchImpl })).rejects.toThrow(
      "annen vert",
    );
  });

  it("følger ikke omdirigeringer til http, uten Location eller i for lange kjeder", async () => {
    const fake = createFakeFetch({
      "https://example.no/ned": new Response(null, { status: 301, headers: { location: "http://example.no/x" } }),
      "https://example.no/tom": new Response(null, { status: 302 }),
      "https://example.no/r1": new Response(null, { status: 302, headers: { location: "/r2" } }),
      "https://example.no/r2": new Response(null, { status: 302, headers: { location: "/r3" } }),
      "https://example.no/r3": new Response(null, { status: 302, headers: { location: "/r4" } }),
      "https://example.no/r4": new Response(null, { status: 302, headers: { location: "/r5" } }),
      "https://example.no/r5": new Response("for langt"),
    });
    const options = { ...base, fetchImpl: fake.fetchImpl };
    await expect(politeFetch("https://example.no/ned", options)).rejects.toThrow("Bare https");
    await expect(politeFetch("https://example.no/tom", options)).rejects.toThrow("uten Location");
    await expect(politeFetch("https://example.no/r1", options)).rejects.toThrow("For mange omdirigeringer");
    expect(fake.urls()).not.toContain("https://example.no/r5");
  });

  it("sjekker hver adresse, også målet for en omdirigering, før den hentes", async () => {
    const fake = createFakeFetch({
      "https://example.no/rss": new Response(null, { status: 301, headers: { location: "/privat/rss" } }),
      "https://example.no/privat/rss": new Response("hemmelig"),
    });
    const checkUrl = (url: URL) => (url.pathname.startsWith("/privat/") ? "robots.txt sperrer /privat/" : null);
    await expect(
      politeFetch("https://example.no/rss", { ...base, fetchImpl: fake.fetchImpl, checkUrl }),
    ).rejects.toThrow(AccessDeniedError);
    expect(fake.urls()).toEqual(["https://example.no/rss"]);
  });

  it("stopper svar som er for store, også uten Content-Length", async () => {
    const big = "x".repeat(200);
    const declared = createFakeFetch({
      "https://example.no/stor": new Response(big, { headers: { "content-length": "200" } }),
    });
    await expect(politeFetch("https://example.no/stor", { ...base, fetchImpl: declared.fetchImpl })).rejects.toThrow(
      FetchError,
    );

    const streamed = createFakeFetch({
      "https://example.no/strom": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 5; i++) controller.enqueue(new TextEncoder().encode("x".repeat(50)));
              controller.close();
            },
          }),
        ),
    });
    await expect(politeFetch("https://example.no/strom", { ...base, fetchImpl: streamed.fetchImpl })).rejects.toThrow(
      "for stort",
    );
  });

  it("dekoder tegnsett fra Content-Type", async () => {
    const latin1 = new Uint8Array([0x62, 0xe5, 0x74]); // «båt» i ISO-8859-1
    const fake = createFakeFetch({
      "https://example.no/latin1": new Response(latin1, { headers: { "content-type": "text/xml; charset=ISO-8859-1" } }),
    });
    const result = await politeFetch("https://example.no/latin1", { ...base, fetchImpl: fake.fetchImpl });
    expect(result.body).toBe("båt");
  });

  it("leser tegnsett fra <meta charset> når headeren mangler det", async () => {
    const page = `<html><head><meta charset="iso-8859-1"></head><body>syltet\xf8y</body></html>`;
    const bytes = Uint8Array.from(page, (char) => char.charCodeAt(0));
    const fake = createFakeFetch({
      "https://example.no/side": new Response(bytes, { headers: { "content-type": "text/html" } }),
    });
    const result = await politeFetch("https://example.no/side", { ...base, maxBytes: 1000, fetchImpl: fake.fetchImpl });
    expect(result.body).toContain("syltetøy");
  });

  it("gir tydelig feil ved tidsavbrudd", async () => {
    const fake = createFakeFetch({
      "https://example.no/treg": (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(
      politeFetch("https://example.no/treg", { ...base, timeoutMs: 20, fetchImpl: fake.fetchImpl }),
    ).rejects.toThrow("Tidsavbrudd");
  });
});
