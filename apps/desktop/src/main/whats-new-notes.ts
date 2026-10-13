/**
 * The running version's part of CHANGELOG.md, as the What's new sheet lists it.
 *
 * Read at BUILD time (electron.vite.config.ts bakes the result into main), so the sheet needs no
 * network and always describes the build it is in. Kept free of Node and Electron imports for that
 * reason: the build config imports it.
 *
 * The changelog is written by hand in two shapes, and both become a list:
 *  - a paragraph that opens on a bold sentence ("**Make team works when…**") is listed by that
 *    sentence alone — it is the summary, and the rest is a click away on the changelog;
 *  - a "- " list item is listed whole, since its bold lead is a name rather than a sentence.
 * A "### " heading starts a group. A paragraph with no bold lead is listed whole.
 */

/** A run of text, bold or code or neither — the only two spans the changelog uses. */
export type NoteSpan = { text: string; strong?: true; code?: true };
export type NoteGroup = { title: string | null; items: NoteSpan[][] };
export type ReleaseNotes = { version: string; date: string | null; groups: NoteGroup[] };

const HEAD = /^##\s+v?(\S+?)(?:\s+[—–-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

/** The notes for `version` ("2.1.1" or "v2.1.1"), or null when the changelog has no section for it. */
export function releaseNotes(markdown: string, version: string): ReleaseNotes | null {
  const want = version.replace(/^v/, "");
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => HEAD.exec(l)?.[1] === want);
  if (start < 0) return null;
  const date = HEAD.exec(lines[start]!)?.[2] ?? null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const body = lines.slice(start + 1, end < 0 ? undefined : end);

  const groups: NoteGroup[] = [];
  let group: NoteGroup = { title: null, items: [] };
  let block: string[] = [];
  const flush = () => {
    if (block.length > 0) group.items.push(...itemsOf(block));
    block = [];
  };
  for (const line of body) {
    const h = /^###\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      if (group.items.length > 0) groups.push(group);
      group = { title: h[1]!, items: [] };
    } else if (line.trim() === "") flush();
    else block.push(line);
  }
  flush();
  if (group.items.length > 0) groups.push(group);
  return { version: want, date, groups };
}

/** One block of lines — a paragraph, or a run of list items — as the items it lists. */
function itemsOf(block: string[]): NoteSpan[][] {
  if (/^\s*[-*]\s/.test(block[0]!)) {
    const items: string[] = [];
    for (const line of block) {
      if (/^\s*[-*]\s/.test(line)) items.push(line.replace(/^\s*[-*]\s+/, ""));
      else items[items.length - 1] += ` ${line.trim()}`;
    }
    return items.map(spans);
  }
  const text = block.map((l) => l.trim()).join(" ");
  const lead = /^\*\*(.+?)\*\*/.exec(text);
  return [lead ? spans(lead[1]!) : spans(text)];
}

/** `**bold**`, `` `code` `` and backslash escapes; everything else is text. */
export function spans(text: string): NoteSpan[] {
  const out: NoteSpan[] = [];
  let run = "";
  let strong = false;
  const push = (code?: string) => {
    if (run) out.push(strong ? { text: run, strong: true } : { text: run });
    run = "";
    if (code !== undefined) out.push(strong ? { text: code, code: true, strong: true } : { text: code, code: true });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) { run += text[++i]; continue; }
    if (ch === "*" && text[i + 1] === "*") { push(); strong = !strong; i++; continue; }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i) { push(text.slice(i + 1, close)); i = close; continue; }
    }
    run += ch;
  }
  push();
  return out;
}
