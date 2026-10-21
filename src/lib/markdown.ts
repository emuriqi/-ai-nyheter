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
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: inline(paragraph.join(" ")) });
    paragraph = [];
  };
  const endList = () => {
    if (list.length > 0) blocks.push({ type: "list", items: list });
    list = [];
  };

  // Linje for linje, så en mellomtittel eller en liste rett før eller etter tekst uten tom linje også tolkes.
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines.map((l) => l.trim())) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const item = line.match(/^[-*]\s+(.+)$/);
    if (!line || heading) {
      endParagraph();
      endList();
      if (heading) blocks.push({ type: "heading", text: inline(heading[1]) });
    } else if (item) {
      endParagraph();
      list.push(inline(item[1]));
    } else {
      endList();
      paragraph.push(line);
    }
  }
  endParagraph();
  endList();
  return blocks;
}

/** Fjerner Markdown-tegn for utheving, siden de ikke vises som utheving. */
function inline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|[.,;:!?]|$)/g, "$1$2");
}
