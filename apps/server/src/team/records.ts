import { parseMemoryEntry, formatMemoryEntry, memoryEntryProblem, type MemoryEntry } from "@realm/contracts";

export type RecordEdit =
  | { op: "add"; section: string | null; entry: string }
  | { op: "replace"; match: string; entry: string }
  | { op: "remove"; match: string };

/**
 * One bullet of a record file changed, as text. `add` puts the entry at the end of its `## section`
 * (made if missing) or, with no section, after the head's last bullet; `replace` and `remove` need
 * exactly one bullet holding `match`. The entry is stamped as memory entries are — `source` is always
 * the caller's (`stamp`), `added` today unless given — so a record line says where it was learned.
 */
export function applyRecordEdit(markdown: string, edit: RecordEdit, stamp: { source: string; added: string }):
  { ok: true; content: string; line: string | null } | { ok: false; error: string } {
  const lines = markdown.split("\n");
  const entryOf = (raw: string): MemoryEntry | string => {
    const parsed = parseMemoryEntry(/^[-*+]\s/.test(raw.trim()) ? raw.trim() : `- ${raw.trim()}`);
    if (!parsed) return "the entry is empty";
    const { source: _given, added, ...rest } = parsed.meta;
    const e: MemoryEntry = { text: parsed.text, meta: { ...rest, source: stamp.source, added: added ?? stamp.added } };
    return memoryEntryProblem(e) ?? e;
  };
  if (edit.op === "add") {
    const e = entryOf(edit.entry);
    if (typeof e === "string") return { ok: false, error: e };
    const line = formatMemoryEntry(e);
    let at: number;
    if (edit.section) {
      const head = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase() === edit.section!.trim().toLowerCase());
      if (head === -1) {
        while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
        lines.push("", `## ${edit.section.trim()}`, line, "");
        return { ok: true, content: lines.join("\n"), line };
      }
      let end = head + 1;
      while (end < lines.length && !/^##?\s+/.test(lines[end]!)) end++;
      at = end;
      while (at > head + 1 && lines[at - 1]!.trim() === "") at--;
    } else {
      const firstSection = lines.findIndex((l) => /^##\s+/.test(l));
      at = firstSection === -1 ? lines.length : firstSection;
      while (at > 1 && lines[at - 1]!.trim() === "") at--;
    }
    lines.splice(at, 0, line);
    return { ok: true, content: lines.join("\n"), line };
  }
  const needle = edit.match.trim().toLowerCase();
  if (!needle) return { ok: false, error: "say which line to change: give its text in `match`" };
  const hits = lines.flatMap((l, i) => (parseMemoryEntry(l) && l.toLowerCase().includes(needle) ? [i] : []));
  if (hits.length === 0) return { ok: false, error: `no line of the record holds "${edit.match}"` };
  if (hits.length > 1) return { ok: false, error: `${hits.length} lines hold "${edit.match}" — give more of the line` };
  if (edit.op === "remove") {
    lines.splice(hits[0]!, 1);
    return { ok: true, content: lines.join("\n"), line: null };
  }
  const e = entryOf(edit.entry);
  if (typeof e === "string") return { ok: false, error: e };
  const line = formatMemoryEntry(e);
  lines[hits[0]!] = line;
  return { ok: true, content: lines.join("\n"), line };
}
