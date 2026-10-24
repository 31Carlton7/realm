import { parseFileRef } from "../session/file-links";

/**
 * A sub-agent's brief, read into the parts a lead writes it in — "Where you work", "Read first",
 * "What to build" — so the viewer can draw each as what it is: a place, a list of files, the work.
 *
 * The brief is the lead's own text and arrives in whatever shape the lead chose, so this reads and
 * never rewrites: every section keeps its words, its label is the lead's label, and the order is the
 * lead's order. A brief with no labels at all is one untitled section, drawn as the prose it is.
 */

export type BriefKind = "where" | "read" | "build" | "rules" | "check" | "report" | "other";

export type BriefSection = {
  /** The lead's label, sentence-cased only where it was typed in capitals. Null for what comes
   *  before the first label. */
  label: string | null;
  kind: BriefKind;
  /** The section's Markdown, label removed. */
  body: string;
};

/** Which part of a brief a label names. Matched on the label's opening words, so "Read these first"
 *  and "Files to read" both land on the file list, and an unknown label is simply a section. */
const KINDS: readonly [BriefKind, RegExp][] = [
  ["where", /^(where (you|to|it)( will)? work|where|working directory|work ?tree|checkout|workspace|repo(sitory)?|location|cwd|environment)\b/i],
  ["read", /^(read( these| this)?( files)?( first| before)?|files to read|(key|relevant|context) files|context|background|references?|start (by reading|with|here))\b/i],
  ["build", /^(what to (build|do|make|change|fix)|what you('re| are) (building|doing)|the (task|work|ask|plan|change|job)|task|tasks?|goal|objective|build|implement(ation)?|your (task|job))\b/i],
  ["rules", /^(rules|constraints|don'?ts?|do not|never|limits|boundaries|guardrails)\b/i],
  ["check", /^(proof( required)?|verify|verification|tests?|testing|done when|acceptance( criteria)?|checks?|how to check)\b/i],
  ["report", /^(report( back)?|deliverables?|when (you are )?done|output|return|hand ?off)\b/i],
];

export function kindOf(label: string): BriefKind {
  for (const [kind, re] of KINDS) if (re.test(label.trim())) return kind;
  return "other";
}

/** A label typed in capitals is shouted, and the viewer names sections in sentence case; anything
 *  else is left exactly as the lead wrote it. */
function sentenceCase(label: string): string {
  const t = label.trim();
  if (!/[A-Z]/.test(t) || t !== t.toUpperCase()) return t;
  const lower = t.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** A label is a few words — not a sentence that happens to end in a colon. */
const LABEL = String.raw`[A-Za-z][A-Za-z0-9 '’/&()-]{0,40}`;
const ATX = /^\s{0,3}#{1,6}\s+(.+?)\s*:?\s*#*\s*$/;
const BOLD = new RegExp(String.raw`^\s{0,3}(?:\*\*|__)(${LABEL}?)(:?)(?:\*\*|__)(:?)\s*(.*)$`);
const PLAIN = new RegExp(String.raw`^(${LABEL}):\s*(.*)$`);
const FENCE = /^\s{0,3}(```|~~~)/;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** The label a line opens a section with, and what follows it on the same line — or null for a line
 *  of the body. A plain "Label:" opens one only when the label is a few words AND either stands alone
 *  or is a label briefs are known to use: "Note: keep it short" is a sentence, "Facts:" alone is a
 *  head, and "Where you work: /repo" is both. */
function headOf(line: string): { label: string; rest: string } | null {
  const atx = ATX.exec(line);
  if (atx) return { label: atx[1]!.replace(/[*_]{2}/g, "").replace(/:$/, "").trim(), rest: "" };
  // Bold that opens a sentence ("**Do not** push") is emphasis; a bold label has its colon or its line.
  const bold = BOLD.exec(line);
  if (bold && words(bold[1]!) <= 6 && (bold[2] || bold[3] || bold[4]!.trim() === "")) return { label: bold[1]!.trim(), rest: bold[4]!.trim() };
  const plain = PLAIN.exec(line);
  if (plain && words(plain[1]!) <= 5 && !/^https?$/i.test(plain[1]!)) {
    const rest = plain[2]!.trim();
    if (rest === "" || kindOf(plain[1]!) !== "other") return { label: plain[1]!.trim(), rest };
  }
  return null;
}

export function briefSections(text: string): BriefSection[] {
  const out: BriefSection[] = [];
  let label: string | null = null;
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    const body = lines.join("\n").trim();
    if (label !== null || body !== "") out.push({ label: label === null ? null : sentenceCase(label), kind: label === null ? "build" : kindOf(label), body });
    lines = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const head = fenced ? null : headOf(line);
    if (!head) { lines.push(line); continue; }
    flush();
    label = head.label;
    if (head.rest) lines.push(head.rest);
  }
  flush();
  return out;
}

/* ── What a section names ────────────────────────────────────────────────────── */

/** A folder, the ways a brief writes one: absolute or from home, in backticks or bare. */
const DIR = /`((?:~|\/)[^`\s]*)`|(?:^|[\s(])((?:~\/|\/)[^\s`,;)]+)/;
const BRANCH = /\bbranch(?:\s+is|:)?\s+[`'"“]?([\w./@+-]+?)[`'"”]?(?=[\s,;.)]|$)/i;

export type BriefPlace = { path: string; branch: string | null };

/** Where the sub-agent works, read out of its "Where you work" section: the first folder it names,
 *  and the branch if it says one. Null where it names no folder. */
export function placeOf(body: string): BriefPlace | null {
  const m = DIR.exec(body);
  const path = (m?.[1] ?? m?.[2] ?? "").replace(/[.:]+$/, "");
  if (!path || path === "/" || path === "~") return null;
  const branch = BRANCH.exec(body)?.[1]?.replace(/[.,]+$/, "") ?? null;
  return { path, branch };
}

/** The section's words with the sentences the chip already says taken out: a sentence that names the
 *  place and says nothing past it goes, every other sentence stays as the lead wrote it. Empty when
 *  the chip says all of it. */
export function besidePlace(body: string, drawn: readonly string[]): string {
  return body.split("\n").map((line) => line.split(/(?<=[.!?])\s+(?=[A-Z`*_(\[])/)
    .filter((sentence) => !drawn.some((d) => sentence.includes(d)) || saysMore(sentence, drawn)).join(" "))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Whether a section says anything beyond the things drawn for it: what is left once the named
 *  paths, the branch and the words that only introduce them are gone. Two words left over ("Work
 *  in") are the sentence the chip already is; a clause ("Never touch the real home") is not. */
export function saysMore(body: string, drawn: readonly string[]): boolean {
  let rest = body;
  for (const d of drawn) rest = rest.split(d).join(" ");
  rest = rest.replace(BRANCH, " ").replace(/`[^`]*`/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(work|works|working|in|on|at|the|a|an|your|its|own|worktree|checkout|folder|directory|branch|and|is|of|from|read|first|these|this|files?|only|off|origin|main|master)\b/gi, " ");
  return words(rest) > 0;
}

export type BriefFile = { ref: string; line: number | null; label: string };

/** A list item that opens with a file: the file, and what the lead said about it. */
export type BriefFileItem = { file: BriefFile; note: string };

const ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/;
/** What sits between a file and the lead's words about it: a dash, a colon, a comma. */
const SEP = /^\s*(?:[—–-]+|:|,)\s*/;

function fileAt(text: string): { file: BriefFile; rest: string } | null {
  const t = text.trimStart();
  const m = /^`([^`]+)`|^\[([^\]]+)\]\(([^)\s]+)\)|^(\S+)/.exec(t);
  if (!m) return null;
  const raw = m[1] ?? m[3] ?? m[4] ?? "";
  const ref = parseFileRef(raw.replace(/[.,;:]+$/, "")) ?? (m[3] ? parseFileRef(m[2]!) : null);
  if (!ref) return null;
  return { file: { ref: ref.ref, line: ref.line, label: m[2] ?? ref.ref }, rest: t.slice(m[0].length) };
}

/**
 * The "Read first" section as files, when it is written as a list of them: every item opens with a
 * file, and the rest of the item is the note. Null when any item does not — a list that mixes files
 * and sentences is read as the prose it is, where the files are still links (`file-links.ts`), so
 * nothing is pulled out of a sentence it belonged to. A line of only files ("`a.ts`, `b.ts`") is a
 * list of them too.
 */
export function readList(body: string): BriefFileItem[] | null {
  const lines = body.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const items: BriefFileItem[] = [];
  if (lines.every((l) => ITEM.test(l))) {
    for (const l of lines) {
      const at = fileAt(ITEM.exec(l)![1]!);
      if (!at) return null;
      items.push({ file: at.file, note: at.rest.replace(SEP, "").trim() });
    }
    return items;
  }
  if (lines.length === 1) {
    for (const part of lines[0]!.split(/\s*(?:,|;|\band\b)\s*/)) {
      if (part.trim() === "") continue;
      const at = fileAt(part);
      if (!at || at.rest.trim().replace(/[.]$/, "") !== "") return null;
      items.push({ file: at.file, note: "" });
    }
    return items.length ? items : null;
  }
  return null;
}
