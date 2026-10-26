import { refresh } from "next/cache";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import {
  abortClustering,
  approveArticleAction,
  detachStoryItem,
  moveStoryItem,
  regenerateArticleAction,
  rejectArticleAction,
  retryStoryAction,
  runIngestNow,
  unpublishArticleAction,
} from "@/app/admin/actions";
import {
  approveArticle,
  regenerateArticle,
  rejectArticle,
  retryStory,
  ReviewError,
  unpublishArticle,
} from "@/lib/generate/review";
import { detachItem, ManualClusterError, markClusteringAborted, moveItem } from "@/lib/cluster/manual";
import { runPipeline } from "@/lib/ingest/pipeline";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/ingest/pipeline", () => ({ runPipeline: vi.fn(async () => ({})) }));
vi.mock("@/lib/generate/review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/generate/review")>()),
  approveArticle: vi.fn(async () => undefined),
  rejectArticle: vi.fn(async () => undefined),
  regenerateArticle: vi.fn(async () => undefined),
  retryStory: vi.fn(async () => undefined),
  unpublishArticle: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
}));
vi.mock("@/lib/cluster/manual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cluster/manual")>()),
  detachItem: vi.fn(async () => "ny-sak"),
  moveItem: vi.fn(async () => undefined),
  markClusteringAborted: vi.fn(async () => 1),
}));

const TOKEN = "Zk7vQ2pL9xR4mN8sT1wY6bC3";

function requestHeaders(authorization?: string) {
  const value = new Headers(authorization ? { authorization } : {});
  vi.mocked(headers).mockResolvedValue(value as Awaited<ReturnType<typeof headers>>);
}

/** Server actions kan kalles med en direkte POST, så knappen må sjekke tilgang selv. */
describe("admin: «Kjør innhenting nå»", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.mocked(runPipeline).mockClear();
    vi.mocked(refresh).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kjører ingenting uten gyldig innlogging", async () => {
    requestHeaders();
    await expect(runIngestNow()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("kjører jobben som manuell og oppdaterer siden", async () => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await runIngestNow();
    expect(runPipeline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: "manual" }));
    expect(refresh).toHaveBeenCalled();
  });
});

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("admin: flytting av elementer mellom saker", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.mocked(detachItem).mockClear();
    vi.mocked(moveItem).mockClear();
    vi.mocked(refresh).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("endrer ingenting uten gyldig innlogging", async () => {
    requestHeaders();
    await expect(detachStoryItem(form({ itemId: "abc" }))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(moveStoryItem(form({ itemId: "abc", storyId: "def" }))).rejects.toThrow(
      "NEXT_HTTP_ERROR_FALLBACK;404",
    );
    expect(detachItem).not.toHaveBeenCalled();
    expect(moveItem).not.toHaveBeenCalled();
  });

  it("skiller ut og flytter med gyldige id-er, og fjerner en gammel feilmelding fra adressen", async () => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await expect(detachStoryItem(form({ itemId: "abc123" }))).rejects.toThrow("REDIRECT /admin/saker");
    expect(detachItem).toHaveBeenCalledWith(expect.anything(), "abc123");
    await expect(moveStoryItem(form({ itemId: "abc123", storyId: "def456" }))).rejects.toThrow("REDIRECT /admin/saker");
    expect(moveItem).toHaveBeenCalledWith(expect.anything(), "abc123", "def456");
    expect(vi.mocked(redirect).mock.calls.slice(-2)).toEqual([["/admin/saker"], ["/admin/saker"]]);
  });

  it("avviser ugyldige id-er og sender forventede feil som kode, aldri som fritekst", async () => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await expect(moveStoryItem(form({ itemId: "abc", storyId: "../x" }))).rejects.toThrow(
      "REDIRECT /admin/saker?feil=ugyldig",
    );
    await expect(detachStoryItem(new FormData())).rejects.toThrow("REDIRECT /admin/saker?feil=ugyldig");
    expect(moveItem).not.toHaveBeenCalled();
    expect(detachItem).not.toHaveBeenCalled();

    vi.mocked(detachItem).mockRejectedValueOnce(new ManualClusterError("har-artikkel"));
    await expect(detachStoryItem(form({ itemId: "abc" }))).rejects.toThrow("REDIRECT /admin/saker?feil=har-artikkel");

    vi.mocked(moveItem).mockRejectedValueOnce(new ManualClusterError("gruppering-kjorer"));
    await expect(moveStoryItem(form({ itemId: "abc", storyId: "def" }))).rejects.toThrow(
      "REDIRECT /admin/saker?feil=gruppering-kjorer",
    );

    // Uventede feil vises som vanlig feilside.
    vi.mocked(detachItem).mockRejectedValueOnce(new Error("databasefeil"));
    await expect(detachStoryItem(form({ itemId: "abc" }))).rejects.toThrow("databasefeil");
  });
});

describe("admin: «Marker som avbrutt»", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.mocked(markClusteringAborted).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("krever innlogging", async () => {
    requestHeaders();
    await expect(abortClustering()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(markClusteringAborted).not.toHaveBeenCalled();
  });

  it("markerer jobben og går tilbake til sakssiden", async () => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await expect(abortClustering()).rejects.toThrow("REDIRECT /admin/saker");
    expect(markClusteringAborted).toHaveBeenCalledTimes(1);
  });
});

describe("admin: godkjenning av artikler", () => {
  const actions = [
    ["godkjenn", approveArticleAction, approveArticle, "publisert"],
    ["avvis", rejectArticleAction, rejectArticle, "avvist"],
    ["skriv på nytt", regenerateArticleAction, regenerateArticle, "skrives-paa-nytt"],
    ["avpubliser", unpublishArticleAction, unpublishArticle, "avpublisert"],
  ] as const;

  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    for (const [, , fn] of actions) vi.mocked(fn).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(actions)("%s: krever innlogging", async (_name, action, fn) => {
    requestHeaders();
    await expect(action(form({ articleId: "abc", note: "x" }))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(actions)("%s: kjører og melder resultatet som kode", async (_name, action, fn, success) => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await expect(action(form({ articleId: "abc123", note: "Begrunnelse" }))).rejects.toThrow(
      `REDIRECT /admin/godkjenning?melding=${success}`,
    );
    expect(fn).toHaveBeenCalledWith(
      expect.anything(),
      "abc123",
      ...(fn === approveArticle
        ? []
        : fn === regenerateArticle
          ? [expect.objectContaining({ config: expect.anything() })]
          : ["Begrunnelse"]),
    );
  });

  it("går tilbake til samme sider av listene etter en handling", async () => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await expect(
      unpublishArticleAction(form({ articleId: "abc123", note: "Begrunnelse", publisert: "3", avvist: "1" })),
    ).rejects.toThrow("REDIRECT /admin/godkjenning?melding=avpublisert&publisert=3");
    // Bare gyldige sidetall følger med.
    await expect(approveArticleAction(form({ articleId: "abc123", publisert: "../x", avvist: "2" }))).rejects.toThrow(
      "REDIRECT /admin/godkjenning?melding=publisert&avvist=2",
    );
  });

  it("«Prøv igjen» nullstiller en sak der skrivingen feilet", async () => {
    requestHeaders();
    await expect(retryStoryAction(form({ storyId: "abc" }))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(retryStory).not.toHaveBeenCalled();
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await expect(retryStoryAction(form({ storyId: "abc123" }))).rejects.toThrow(
      "REDIRECT /admin/godkjenning?melding=proves-igjen",
    );
    expect(retryStory).toHaveBeenCalledWith(
      expect.anything(),
      "abc123",
      expect.objectContaining({ config: expect.anything() }),
    );
    vi.mocked(retryStory).mockRejectedValueOnce(new ReviewError("for-gammel"));
    await expect(retryStoryAction(form({ storyId: "abc123" }))).rejects.toThrow(
      "REDIRECT /admin/godkjenning?melding=for-gammel",
    );
  });

  it("avviser ugyldige id-er og melder forventede feil som kode", async () => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await expect(approveArticleAction(form({ articleId: "../x" }))).rejects.toThrow(
      "REDIRECT /admin/godkjenning?melding=ugyldig",
    );
    expect(approveArticle).not.toHaveBeenCalled();
    vi.mocked(approveArticle).mockRejectedValueOnce(new ReviewError("blokkert"));
    await expect(approveArticleAction(form({ articleId: "abc" }))).rejects.toThrow(
      "REDIRECT /admin/godkjenning?melding=blokkert",
    );
    vi.mocked(approveArticle).mockRejectedValueOnce(new Error("databasefeil"));
    await expect(approveArticleAction(form({ articleId: "abc" }))).rejects.toThrow("databasefeil");
  });
});
