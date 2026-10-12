import { siteConfig } from "@/lib/config";

export function SiteFooter() {
  const { editor } = siteConfig;
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto max-w-4xl space-y-2 px-4 py-8 text-sm text-muted">
        <p>
          Ansvarlig redaktør: {editor.name}
          {editor.isPlaceholder ? " (plassholder – dette er et demoprosjekt)" : ` (${editor.email})`}
        </p>
        <p>
          Alt innhold er AI-generert med Claude fra {siteConfig.ai.provider} og bygger kun på åpent
          lisensierte kilder. Ingen sporingscookies.
        </p>
      </div>
    </footer>
  );
}
