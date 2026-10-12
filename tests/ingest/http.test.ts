import { describe, expect, it } from "vitest";
import { FetchError, politeFetch } from "@/lib/ingest/http";
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
