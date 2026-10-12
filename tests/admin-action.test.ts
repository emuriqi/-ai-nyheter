import { refresh } from "next/cache";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import { detachStoryItem, moveStoryItem, runIngestNow } from "@/app/admin/actions";
import { detachItem, ManualClusterError, moveItem } from "@/lib/cluster/manual";
import { runPipeline } from "@/lib/ingest/pipeline";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/ingest/pipeline", () => ({ runPipeline: vi.fn(async () => ({})) }));
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

  it("skiller ut og flytter med gyldige id-er", async () => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await detachStoryItem(form({ itemId: "abc123" }));
    expect(detachItem).toHaveBeenCalledWith(expect.anything(), "abc123");
    await moveStoryItem(form({ itemId: "abc123", storyId: "def456" }));
    expect(moveItem).toHaveBeenCalledWith(expect.anything(), "abc123", "def456");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("avviser ugyldige id-er og viser forventede feil som melding", async () => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await expect(moveStoryItem(form({ itemId: "abc", storyId: "../x" }))).rejects.toThrow(
      `REDIRECT /admin/saker?feil=${encodeURIComponent("Ugyldig element eller sak.")}`,
    );
    expect(moveItem).not.toHaveBeenCalled();

    vi.mocked(detachItem).mockRejectedValueOnce(new ManualClusterError("Saken har en artikkel."));
    await expect(detachStoryItem(form({ itemId: "abc" }))).rejects.toThrow(
      `REDIRECT /admin/saker?feil=${encodeURIComponent("Saken har en artikkel.")}`,
    );
    expect(redirect).toHaveBeenCalled();

    vi.mocked(detachItem).mockRejectedValueOnce(new Error("databasefeil"));
    await expect(detachStoryItem(form({ itemId: "abc" }))).rejects.toThrow("databasefeil");
  });
});
