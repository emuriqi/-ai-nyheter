import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAdminOverview,
  getRecentItemsForAdmin,
  getReviewQueue,
  getSourcesForAdmin,
  getStoriesForAdmin,
} from "@/lib/admin";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => {
    throw new Error("databasen ble lest uten tilgangskontroll");
  }),
}));

const TOKEN = "Zk7vQ2pL9xR4mN8sT1wY6bC3";

function requestHeaders(authorization?: string) {
  const value = new Headers(authorization ? { authorization } : {});
  vi.mocked(headers).mockResolvedValue(value as Awaited<ReturnType<typeof headers>>);
}

/**
 * Datalaget skal avvise forespørsler uten gyldig innlogging før databasen
 * leses, uavhengig av proxyen.
 */
describe("tilgangskontroll i datalaget for admin", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    vi.mocked(getDb).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["getAdminOverview", getAdminOverview],
    ["getSourcesForAdmin", getSourcesForAdmin],
    ["getRecentItemsForAdmin", () => getRecentItemsForAdmin()],
    ["getStoriesForAdmin", () => getStoriesForAdmin()],
    ["getReviewQueue", getReviewQueue],
  ])("%s avviser forespørsler uten innlogging før databasen leses", async (_name, fn) => {
    requestHeaders();
    await expect(fn()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(getDb).not.toHaveBeenCalled();
  });

  it("avviser feil passord", async () => {
    requestHeaders(`Basic ${Buffer.from("admin:feil-passord-som-er-langt").toString("base64")}`);
    await expect(requireAdmin()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("slipper gjennom med riktig passord", async () => {
    requestHeaders(`Basic ${Buffer.from(`admin:${TOKEN}`).toString("base64")}`);
    await expect(requireAdmin()).resolves.toBeUndefined();
  });
});
