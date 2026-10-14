/**
 * En liten, trygg tolkning av brødteksten (Markdown fra Claude): avsnitt,
 * mellomtitler og punktlister. Ingen HTML, lenker eller bilder. Teksten
 * vises av React og escapes derfor alltid.
 */
export type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "list"; items: string[] };

export function parseBody(body: string): Block[] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk): Block => {
      const heading = chunk.match(/^#{1,6}\s+(.+)$/);
      if (heading && !chunk.includes("\n")) return { type: "heading", text: inline(heading[1]) };
      const lines = chunk.split("\n").map((line) => line.trim());
      if (lines.every((line) => /^[-*]\s+/.test(line))) {
        return { type: "list", items: lines.map((line) => inline(line.replace(/^[-*]\s+/, ""))) };
      }
      return { type: "paragraph", text: inline(lines.join(" ")) };
    });
}

/** Fjerner Markdown-tegn for utheving, siden de ikke vises som utheving. */
function inline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|[.,;:!?]|$)/g, "$1$2");
}
