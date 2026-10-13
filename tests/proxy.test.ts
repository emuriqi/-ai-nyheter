import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "@/proxy";

const TOKEN = "Zk7vQ2pL9xR4mN8sT1wY6bC3";
const basic = (password: string) => `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;

describe("proxy: hvilke ruter som beskyttes", () => {
  it.each(["/admin", "/admin/", "/admin/kilder", "/admin/kilder/ny", "/api/admin/innhenting"])("dekker %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });

  it.each(["/", "/api/health", "/sak/en-sak", "/administrasjon-av-noe"])("lar %s være", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });
});

describe("proxy: svar", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const request = (authorization?: string) =>
    new NextRequest("http://localhost/admin/kilder", {
      headers: authorization ? { authorization } : {},
    });

  it("ber om innlogging uten gyldig passord", () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    for (const response of [proxy(request()), proxy(request(basic("feil-passord-som-er-langt")))]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Basic");
    }
  });

  it("slipper gjennom med riktig passord", () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    const response = proxy(request(basic(TOKEN)));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("avslår admin helt når ADMIN_TOKEN mangler eller er svakt", () => {
    vi.stubEnv("ADMIN_TOKEN", "kort");
    expect(proxy(request(basic("kort"))).status).toBe(503);
  });
});

describe("proxy: vern mot innramming (clickjacking)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forbyr innramming av admin i alle svar", () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    const request = (authorization?: string) =>
      new NextRequest("http://localhost/admin/saker", { headers: authorization ? { authorization } : {} });
    const responses = [proxy(request(basic(TOKEN))), proxy(request())];
    vi.stubEnv("ADMIN_TOKEN", "");
    responses.push(proxy(request()));
    expect(responses.map((r) => r.status)).toEqual([200, 401, 503]);
    for (const response of responses) {
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    }
  });
});
