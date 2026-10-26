/**
 * Maskinlesbar merking av at artiklene er laget av kunstig intelligens
 * (AI-forordningen art. 50). Taggen ligger i en statisk layout, så React
 * løfter den inn i <head> i den forhåndsrendrede delen av siden. Den står
 * dermed i <head> for alle, også verktøy uten JavaScript, uten at metadata må
 * blokkere sidevisningen.
 */
export default function ArticleLayout({ children }: LayoutProps<"/sak/[slug]">) {
  return (
    <>
      <meta name="ai-generated" content="true" />
      {children}
    </>
  );
}
