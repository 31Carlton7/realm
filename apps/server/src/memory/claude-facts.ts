/**
 * Claude Code's own auto-memory format, which a space's folder of the profile repo keeps: one fact per
 * file — frontmatter `name`, `description`, `metadata.type`, then the body — and a `MEMORY.md` of one
 * line per fact, `- [Title](file.md) — what it is`. Claude reads and writes these files itself once its
 * memory directory is pointed at the folder; Realm writes them in the same shape so the two never mix.
 */

export type ClaudeFactType = "user" | "feedback" | "project" | "reference";

/** `- [Title](file.md) — hook`, and the `./file.md` spelling of the same link. */
const INDEX_LINE = /^\s*[-*+]\s+\[[^\]]*\]\(\.?\/?([^)\s]+)\)/;

/** The file a line of a Claude `MEMORY.md` links to, or null for any other line. */
export function claudeIndexTarget(line: string): string | null {
  return INDEX_LINE.exec(line)?.[1] ?? null;
}

/** The file a fact is kept in, from its name. Never `memory.md`, which is `MEMORY.md` on a Mac's disk. */
export function claudeFactFile(name: string): string {
  let stem = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+/, "").slice(0, 80).replace(/-+$/, "");
  if (stem === "" || stem === "memory") stem = `${stem || "memory"}-note`;
  return `${stem}.md`;
}

/** A frontmatter value as YAML reads it back: bare when it is plainly a word or a phrase, quoted otherwise. */
const scalar = (s: string): string => (/^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/.test(s) && !s.endsWith(" ") ? s : JSON.stringify(s));

/** One fact as Claude writes one. `source` names the Realm session it came from, when there is one. */
export function claudeFact(f: { name: string; description: string; type: ClaudeFactType; body: string; source?: string }): string {
  const head = ["---", `name: ${scalar(f.name)}`, `description: ${scalar(f.description)}`, "metadata:", `  type: ${f.type}`, ...(f.source ? [`  source: ${scalar(f.source)}`] : []), "---"];
  const body = f.body.trim();
  return `${head.join("\n")}\n${body ? `\n${body}\n` : ""}`;
}

/** `MEMORY.md` with this fact's line: the line already linking `file` is rewritten in place, and a
 *  fact not listed yet is added at the end. */
export function withClaudeIndexLine(index: string, file: string, title: string, hook: string): string {
  const line = `- [${title.replace(/[[\]]/g, "")}](${file}) — ${hook}`;
  const lines = index.trim() === "" ? [] : index.replace(/\n+$/, "").split("\n");
  const at = lines.findIndex((l) => claudeIndexTarget(l) === file);
  if (at === -1) lines.push(line);
  else if (lines[at] === line) return index;
  else lines[at] = line;
  return `${lines.join("\n")}\n`;
}

/**
 * Two Claude `MEMORY.md` files as one: everything `into` has, then each line of `from` it lacks — a
 * link to a file `into` already links is the same fact however it is worded, and any other line
 * counts as there when the same text is. Nothing in `into` is changed or reordered.
 */
export function mergeClaudeIndex(into: string, from: string): string {
  const lines = into.trim() === "" ? [] : into.replace(/\n+$/, "").split("\n");
  const linked = new Set(lines.map(claudeIndexTarget).filter((t): t is string => t !== null));
  const texts = new Set(lines.map((l) => l.trim()));
  const added: string[] = [];
  for (const line of from.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    const target = claudeIndexTarget(line);
    if (target !== null ? linked.has(target) : texts.has(text)) continue;
    if (target !== null) linked.add(target);
    texts.add(text);
    added.push(line.trimEnd());
  }
  if (added.length === 0) return into;
  return `${[...lines, ...added].join("\n")}\n`;
}
