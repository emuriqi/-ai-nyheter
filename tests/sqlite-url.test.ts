import { describe, expect, it } from "vitest";
import { resolveSqliteUrl } from "@/lib/sqlite-url";

describe("resolveSqliteUrl", () => {
  it("gjør relative stier absolutte fra prosjektroten", () => {
    expect(resolveSqliteUrl("file:./prisma/dev.db", "/prosjekt")).toBe("file:/prosjekt/prisma/dev.db");
  });

  it("lar absolutte stier og minnedatabaser være", () => {
    expect(resolveSqliteUrl("file:/data/app.db", "/prosjekt")).toBe("file:/data/app.db");
    expect(resolveSqliteUrl("file::memory:", "/prosjekt")).toBe("file::memory:");
  });

  it("feiler med forklaring når URL mangler eller ikke er SQLite", () => {
    expect(() => resolveSqliteUrl(undefined)).toThrow("DATABASE_URL mangler");
    expect(() => resolveSqliteUrl("postgresql://localhost/db")).toThrow("file:");
  });
});
