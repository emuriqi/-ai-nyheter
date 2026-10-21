import "dotenv/config";
import { createClaudeClient } from "@/lib/ai/claude";
import { siteConfig } from "@/lib/config";
import { checkArticle, stripSourceRefs } from "@/lib/generate/checks";
import { createClaudeModerator, createClaudeWriter } from "@/lib/generate/claude";
import { decide } from "@/lib/generate/decide";
import { loadGeneratedArticles } from "../tests/helpers/generated-articles";

// Viser hvordan kontrollene virker på de syntetiske testartiklene
// (tests/fixtures/generated-articles.json): én god og fem med innplantede feil
// per sak. Kjøres med `npm run eval:generate`.
//
// Med `-- --claude` skriver og modererer Claude artikler for de samme sakene
// (krever ANTHROPIC_API_KEY og koster seks kall), og artiklene og funnene skrives ut.

const { editorial, ai } = siteConfig;
const saker = loadGeneratedArticles();

console.log("Automatiske kontroller på syntetiske artikler:\n");
for (const sak of saker) {
  const good = checkArticle(sak.good, sak.sources, editorial);
  console.log(`${sak.event}: god artikkel ${good.length === 0 ? "uten funn" : `med ${good.length} funn`}`);
  for (const variant of sak.variants) {
    const kinds = checkArticle(variant.artikkel, sak.sources, editorial).map((f) => `${f.kind} (${f.severity})`);
    console.log(`  ${variant.feil.padEnd(16)} → ${kinds.join(", ") || "IKKE FANGET"}`);
  }
}

if (process.argv.includes("--claude")) {
  const client = createClaudeClient();
  if (!client) {
    console.error("\nANTHROPIC_API_KEY er ikke satt. Legg den i .env for å teste med Claude.");
    process.exitCode = 1;
  } else {
    const writer = createClaudeWriter(client, ai.model, editorial);
    const moderator = createClaudeModerator(client, ai.model, editorial);
    const now = new Date();
    for (const sak of saker) {
      console.log(`\n=== ${sak.event} (${sak.sources.length} kilder) ===`);
      const written = await writer.write(sak.sources, now);
      if (!written.ok) {
        console.log(`Ingen artikkel: ${written.reason}`);
        continue;
      }
      const { article, findings: refs } = stripSourceRefs(written.article);
      console.log(`\n${article.tittel}\n\n${article.ingress}\n\n${article.brodtekst}\n`);
      const decision = decide(
        article,
        [...refs, ...checkArticle(article, sak.sources, editorial)],
        await moderator.moderate(sak.sources, article, now),
        editorial,
      );
      console.log(`Vurdering: ${decision.verdict}${decision.blocked ? " (bryter faste regler)" : ""}`);
      for (const f of decision.findings)
        console.log(`  [${f.severity}] ${f.origin}/${f.kind}: ${f.message}${f.excerpt ? ` («${f.excerpt}»)` : ""}`);
    }
    for (const [name, u] of [
      ["Skriver", writer.usage],
      ["Moderator", moderator.usage],
    ] as const) {
      console.log(
        `\n${name}: ${u.calls} kall, ${u.failures} uten svar, ${u.inputTokens} inn- og ${u.outputTokens} ut-tokens`,
      );
    }
  }
}
