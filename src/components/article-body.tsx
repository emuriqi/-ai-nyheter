import { parseBody } from "@/lib/markdown";

/** Brødteksten i en artikkel: avsnitt, mellomtitler og punktlister. */
export function ArticleBody({ body }: { body: string }) {
  return (
    <div className="space-y-4 text-lg leading-relaxed">
      {parseBody(body).map((block, i) => {
        if (block.type === "heading") {
          return (
            <h2 key={i} className="pt-2 font-serif text-xl font-semibold">
              {block.text}
            </h2>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={i} className="list-disc space-y-1 pl-6">
              {block.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{block.text}</p>;
      })}
    </div>
  );
}
