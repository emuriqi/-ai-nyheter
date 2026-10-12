/**
 * Synlig merking av at innholdet er AI-generert (EUs AI-forordning art. 50).
 * Vises på alle sider. Artikler og chat får i tillegg egen merking.
 */
export function AiNotice() {
  return (
    <div role="note" className="border-b border-notice-border bg-notice">
      <p className="mx-auto max-w-4xl px-4 py-2 text-sm">
        <strong>AI-generert innhold.</strong> Artiklene på denne siden skrives av kunstig intelligens og
        bygger kun på kildene som er lenket i hver sak.
      </p>
    </div>
  );
}
