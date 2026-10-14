import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/cron/ingest/route";
import { checkBearerToken } from "@/lib/auth/basic-auth";
import { runPipeline } from "@/lib/ingest/pipeline";

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/ingest/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest/pipeline")>()),
  runPipeline: vi.fn(async () => ({
    sync: { created: 0, updated: 5, paused: 0 },
    ingest: { status: "done", jobId: "job", sources: [] },
    cluster: { status: "skipped", reason: "En gruppering kjører allerede" },
    generate: { status: "skipped", reason: "Skriving er ikke satt opp (krever ANTHROPIC_API_KEY)" },
    retention: { purgedSourceItems: 0, deletedJobRuns: 0 },
  })),
}));

const SECRET = "Qm4wT8zK2vB6nR1xY5cH9pL3";
const request = (authorization?: string) =>
  new Request("http://localhost/api/cron/ingest", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

describe("checkBearerToken", () => {
  it("godtar riktig token og avviser alt annet", () => {
    expect(checkBearerToken(`Bearer ${SECRET}`, SECRET)).toBe("ok");
    expect(checkBearerToken(`bearer ${SECRET}`, SECRET)).toBe("ok");
    expect(checkBearerToken(`Bearer ${SECRET}x`, SECRET)).toBe("unauthorized");
    expect(checkBearerToken(`Basic ${SECRET}`, SECRET)).toBe("unauthorized");
    expect(checkBearerToken(null, SECRET)).toBe("unauthorized");
  });

  it("er avslått når hemmeligheten mangler eller er svak", () => {
    expect(checkBearerToken("Bearer x", undefined)).toBe("disabled");
    expect(checkBearerToken("Bearer kort", "kort")).toBe("disabled");
  });
});

describe("POST /api/cron/ingest", () => {
  beforeEach(() => {
    vi.mocked(runPipeline).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("krever gyldig token og kjører ikke jobben uten", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const response = await POST(request("Bearer feil-token-som-er-langt-nok"));
    expect(response.status).toBe(401);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("er avslått når CRON_SECRET ikke er satt", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await POST(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("kjører innhenting, gruppering og sletting med riktig token", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const response = await POST(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(runPipeline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: "cron" }));
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.summary[0]).toContain("Kilder synkronisert");
    expect(body.summary).toContain("Gruppering hoppet over: En gruppering kjører allerede.");
    expect(body.cluster).toEqual({ status: "skipped", reason: "En gruppering kjører allerede" });
  });

  it("svarer 500 når grupperingen feilet, men tar med oppsummeringen", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.mocked(runPipeline).mockResolvedValueOnce({
      sync: { created: 0, updated: 5, paused: 0 },
      ingest: { status: "done", jobId: "job", sources: [] },
      cluster: { status: "failed", reason: "disken er full" },
      generate: { status: "skipped", reason: "Skriving er ikke satt opp (krever ANTHROPIC_API_KEY)" },
      retention: { purgedSourceItems: 2, deletedJobRuns: 0 },
    } as Awaited<ReturnType<typeof runPipeline>>);
    const response = await POST(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.summary).toContain("Gruppering feilet: disken er full. Elementene grupperes i neste kjøring.");
  });
});
