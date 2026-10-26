import { parseBody } from "@/lib/markdown";

/**
 * Brødteksten i en artikkel: avsnitt, mellomtitler og punktlister.
 * `headingLevel` er nivået for mellomtitlene, så de passer inn under
 * overskriften der teksten vises (h2 på artikkelsiden, h4 i godkjenningskortet).
 */
export function ArticleBody({ body, headingLevel = 2 }: { body: string; headingLevel?: 2 | 3 | 4 }) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className="space-y-4 text-lg leading-relaxed">
      {parseBody(body).map((block, i) => {
        if (block.type === "heading") {
          return (
            <Heading key={i} className="pt-2 font-serif text-xl font-semibold">
              {block.text}
            </Heading>
          );
        }
        if (block.type === "list") {
          const items = block.items.map((item, j) => <li key={j}>{item}</li>);
          return block.ordered ? (
            <ol key={i} className="list-decimal space-y-1 pl-6">
              {items}
            </ol>
          ) : (
            <ul key={i} className="list-disc space-y-1 pl-6">
              {items}
            </ul>
          );
        }
        return <p key={i}>{block.text}</p>;
      })}
    </div>
  );
}
