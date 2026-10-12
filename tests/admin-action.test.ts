import { refresh } from "next/cache";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runIngestNow } from "@/app/admin/actions";
import { runPipeline } from "@/lib/ingest/pipeline";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/ingest/pipeline", () => ({ runPipeline: vi.fn(async () => ({})) }));

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
