import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Roboter som får hele <head> med en gang (tittel, beskrivelse, ai-model og noindex), i stedet for metadata som
  // strømmes inn senere. Next.js' egen liste (next/dist/shared/lib/router/utils/html-bots.js), pluss KI-crawlerne
  // fra ingestion.aiCrawlerTokens og enkle klienter uten JavaScript. Vanlige nettlesere får fortsatt den raske,
  // forhåndsrendrede siden. ai-generated står uansett i <head> for alle (src/app/sak/[slug]/layout.tsx).
  htmlLimitedBots: new RegExp(
    [
      String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot`,
      String.raw`tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit`,
      String.raw`facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`,
      String.raw`ClaudeBot|anthropic-ai|GPTBot|OAI-SearchBot|ChatGPT-User|CCBot|PerplexityBot|Bytespider|Amazonbot`,
      String.raw`curl|Wget|python-requests|Go-http-client`,
    ].join("|"),
    "i",
  ),
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
