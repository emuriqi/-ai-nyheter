import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Metadata (tittel og maskinlesbar AI-merking) skal alltid stå i <head>, også for verktøy som ikke kjører JavaScript.
  // Uten dette strømmes metadata til <body> for vanlige nettlesere og de fleste roboter.
  htmlLimitedBots: /.*/,
  // Ingen sider skal kunne vises i en ramme på et annet nettsted (se også src/proxy.ts for admin).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
