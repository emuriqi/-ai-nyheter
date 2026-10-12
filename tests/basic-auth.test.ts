import { describe, expect, it } from "vitest";
import { checkBasicAuth } from "@/lib/auth/basic-auth";

const TOKEN = "Zk7vQ2pL9xR4mN8sT1wY6bC3"; // 24 tegn, tilfeldig
const header = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("checkBasicAuth", () => {
  it("er avslått når ADMIN_TOKEN mangler", () => {
    expect(checkBasicAuth(header("admin", ""), undefined)).toBe("disabled");
    expect(checkBasicAuth(header("admin", ""), "")).toBe("disabled");
  });

  it("krever minst 24 tegn", () => {
    const tooShort = TOKEN.slice(0, 23);
    expect(checkBasicAuth(header("admin", tooShort), tooShort)).toBe("disabled");
    expect(TOKEN).toHaveLength(24);
    expect(checkBasicAuth(header("admin", TOKEN), TOKEN)).toBe("ok");
  });

  it("avslår svake tokens med for få ulike tegn eller bare mellomrom", () => {
    for (const weak of ["a".repeat(30), "abababababababababababab", " ".repeat(30)]) {
      expect(checkBasicAuth(header("admin", weak), weak)).toBe("disabled");
    }
  });

  it("håndterer passord som inneholder kolon", () => {
    const token = "passord:med:kolon:og-mer-tekst";
    expect(checkBasicAuth(header("admin", token), token)).toBe("ok");
  });

  it.each([
    ["manglende header", null],
    ["feil skjema", `Bearer ${TOKEN}`],
    ["ugyldig base64", "Basic ???"],
    ["mangler kolon", `Basic ${Buffer.from("admin").toString("base64")}`],
    ["feil passord", header("admin", "feil-passord-som-er-langt-nok")],
    ["feil brukernavn", header("root", TOKEN)],
  ])("avviser %s", (_name, value) => {
    expect(checkBasicAuth(value, TOKEN)).toBe("unauthorized");
  });
});
