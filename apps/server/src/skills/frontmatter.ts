/**
 * The smallest frontmatter reader that is correct for what every agent actually reads.
 *
 * All three CLIs key off exactly two fields — `name` and `description` — and ignore the rest
 * (research §1.1). So this is not a YAML parser and must not grow into one: it reads top-level
 * `key: value` pairs out of the leading `---` block and stops. Anything it cannot make sense of comes
 * back as a missing field, which the caller turns into `valid: false` — never into a throw.
 */

export type Frontmatter = Record<string, string>;

/** Strips one layer of matching quotes; YAML escapes inside them are not our problem at this depth. */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Parses the leading `---` block. Returns `null` when there isn't one — an unfenced file is a document,
 * not a skill, and the two failures deserve different words.
 *
 * Block scalars (`description: >-` / `|`) are supported because real skills use them and treating one as
 * an empty description would silently hide a perfectly good skill. Folded (`>`) joins with spaces,
 * literal (`|`) with newlines; chomping indicators are accepted and the trailing newline is trimmed
 * either way, which is all a one-line description cares about.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  return parseSkillDocument(text)?.frontmatter ?? null;
}

/**
 * The same read, keeping the BODY as well — what a viewer shows, and what is left of the file once
 * the frontmatter has done its job.
 *
 * One scanner for both, because where the body starts is defined by where the frontmatter ends, and
 * two readers of one fence would eventually disagree about a block scalar. The body is the author's
 * text unchanged from the line after the closing fence; only that newline is dropped.
 */
export function parseSkillDocument(text: string): { frontmatter: Frontmatter; body: string } | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const out: Frontmatter = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    // Closed: whatever we read is the answer, and everything after this line is the document.
    if (trimmed === "---" || trimmed === "...") return { frontmatter: out, body: lines.slice(i + 1).join("\n") };
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (indentOf(line) > 0) continue; // a nested mapping or list under some other key — not ours to read
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    const block = /^([|>])[+-]?$/.exec(rest);
    if (!block) { out[key] = unquote(rest); continue; }
    const folded = block[1] === ">";
    const body: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (next.trim() !== "" && indentOf(next) === 0) break; // back to column 0 ends the block, `---` included
      body.push(next.trim());
      i++;
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    out[key] = folded ? body.join(" ").trim() : body.join("\n").trim();
  }
  // Ran off the end without a closing fence. Treat it as unfenced rather than guessing: a file whose
  // frontmatter never closes has no body either, and calling it valid would hand the agent a broken skill.
  return null;
}
