import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@config": path.resolve(import.meta.dirname, "config"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Testene skal aldri kalle Claude API, selv om nøkkelen finnes i miljøet.
    env: { ANTHROPIC_API_KEY: "" },
  },
});
