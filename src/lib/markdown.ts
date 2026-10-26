/**
 * En liten, trygg tolkning av brødteksten (Markdown fra Claude): avsnitt,
 * mellomtitler, punktlister og nummererte lister. Ingen HTML, lenker eller
 * bilder. Teksten vises av React og escapes derfor alltid.
 */
export type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "list"; items: string[]; ordered?: boolean };

const BULLET = /^[-*]\s+(.+)$/;
const NUMBERED = /^(\d{1,3})[.)]\s+(.+)$/;

/**
 * Tolker brødteksten linje for linje, som vanlig Markdown: en mellomtittel
 * eller en punktliste kan komme rett etter tekst uten tom linje, en nummerert
 * liste bare hvis den starter med 1, og en linje rett etter et listepunkt
 * hører til punktet.
 */
export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: inline(paragraph.join(" ")) });
    paragraph = [];
  };
  const endList = () => {
    if (list) blocks.push({ type: "list", items: list.items.map(inline), ...(list.ordered ? { ordered: true } : {}) });
    list = null;
  };

  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines.map((l) => l.trim())) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const bullet = line.match(BULLET);
    const numbered = line.match(NUMBERED);
    // En nummerert linje midt i et avsnitt («… fra 2026.\n2. juni …») er vanlig tekst, med mindre den starter på 1.
    const startsList = bullet || (numbered && (paragraph.length === 0 || numbered[1] === "1"));
    if (!line || heading) {
      endParagraph();
      endList();
      if (heading) blocks.push({ type: "heading", text: inline(heading[1]) });
    } else if (startsList || (list && numbered && list.ordered)) {
      const ordered = !bullet;
      const item = bullet ? bullet[1] : numbered![2];
      endParagraph();
      if (list && list.ordered !== ordered) endList();
      list ??= { ordered, items: [] };
      list.items.push(item);
    } else if (list) {
      // Fortsettelsen av et listepunkt.
      list.items[list.items.length - 1] += ` ${line}`;
    } else {
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
