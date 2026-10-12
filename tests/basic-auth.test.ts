import { describe, expect, it } from "vitest";
import { checkBasicAuth } from "@/lib/auth/basic-auth";

const TOKEN = "et-langt-nok-passord";
const header = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("checkBasicAuth", () => {
  it("er avslått når ADMIN_TOKEN mangler eller er for kort", () => {
    expect(checkBasicAuth(header("admin", ""), undefined)).toBe("disabled");
    expect(checkBasicAuth(header("admin", "kort"), "kort")).toBe("disabled");
  });

  it("slipper inn riktig brukernavn og passord", () => {
    expect(checkBasicAuth(header("admin", TOKEN), TOKEN)).toBe("ok");
  });

  it("håndterer passord som inneholder kolon", () => {
    const token = "passord:med:kolon";
    expect(checkBasicAuth(header("admin", token), token)).toBe("ok");
  });

  it.each([
    ["manglende header", null],
    ["feil skjema", `Bearer ${TOKEN}`],
    ["ugyldig base64", "Basic ???"],
    ["mangler kolon", `Basic ${Buffer.from("admin").toString("base64")}`],
    ["feil passord", header("admin", "feil-passord-her")],
    ["feil brukernavn", header("root", TOKEN)],
  ])("avviser %s", (_name, value) => {
    expect(checkBasicAuth(value, TOKEN)).toBe("unauthorized");
  });
});
