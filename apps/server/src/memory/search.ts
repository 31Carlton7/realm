import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { MEMORY_REPO_INDEX_FILE } from "@realm/contracts";

/**
 * `memory_search`: ranked retrieval over the files of the memory repos a session uses.
 *
 * BM25 (k1 1.2, b 0.75), over a small corpus that is mostly one fact per file or one fact per line, so
 * what counts as one document follows the formats:
 *
 * - **A line of an index** (`MEMORY.md`, at the root or in `spaces/<folder>/`) is a document of its own,
 *   with its words weighted ×2: an index line is a fact (AMR) or the hook for one (Claude's
 *   `- [Title](file.md) — hook`), written to be found.
 * - **Any other file** is one document: its frontmatter `name` and `description` (or, with no
 *   frontmatter, its first heading) ×3, the words of its path ×2, the rest ×1. A fact file is one fact,
 *   so a query split between its description and its body still finds it whole.
 *
 * Length is normalised against the average of the same kind of document, so a one-line entry is not
 * favoured just for being short beside a whole file. A query's exact phrase — the whole query, or any
 * "quoted" part — multiplies a document's score by 1.5 for each phrase it holds.
 *
 * Words are matched the way a person means them: case, accents and punctuation do not count
 * (`pixel-office`, `Pixel Office` and `pixeloffice` are one term; `indexesFor` is `indexes`, `for` and
 * `indexesfor`), common endings are folded (`webhooks`/`webhook`, `caching`/`cache`, `retried`/`retry`),
 * and a word of four letters or more also matches the longer words it starts (`notar` → `notarize`)
 * or that start it (`notarization` → `notarize`), at half weight.
 *
 * Each document gives at most one hit, at its best line: the line holding the most of the query's
 * weight. Parsed files are cached by path and keyed on mtime and size, so a search re-reads only the
 * files that changed since the last one. Read-only, in this process, and never a shell over an
 * agent's string.
 */

const K1 = 1.2;
const B = 0.75;
/** A file larger than this is not memory anyone wrote by hand; it is skipped. */
const FILE_MAX = 1_000_000;
const SNIPPET_MAX = 300;
const PREFIX_MIN = 4;
const PREFIX_WEIGHT = 0.5;
const PHRASE_BOOST = 0.5;
const W_TITLE = 3;
const W_INDEX = 2;
const W_PATH = 2;
const W_BODY = 1;

/** One hit: the repo it is in, the file from the repo's root, the 1-based line and that line's text. */
export type SearchHit = { repo: string; path: string; line: number; text: string; score: number };

type Line = { n: number; text: string; terms: Set<string>; title: boolean };
type Doc = {
  repo: string; path: string;
  kind: "entry" | "file";
  /** Weighted term frequency: term → Σ field weight × occurrences. */
  tf: Map<string, number>;
  len: number;
  /** The words in order, folded, for phrase matching. */
  seq: string;
  lines: Line[];
};
type Cached = { mtimeMs: number; size: number; docs: Doc[] };

const STOP = new Set(("a an and are as at be but by for from has have in into is it its of on or that the this to was were will with " +
  "i you we they he she do does not no so if then than there their our your").split(" "));

/** Folds the common English endings so the forms of one word meet: plurals, -ing, -ed, a final e. */
export function stem(w: string): string {
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  let s = w;
  if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (s.endsWith("ies") && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us") && !s.endsWith("is")) s = s.slice(0, -1);
  const suffix = s.endsWith("ing") && s.length > 5 ? 3 : s.endsWith("ed") && s.length > 4 ? 2 : 0;
  if (suffix > 0) {
    s = s.slice(0, -suffix);
    if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/[lsz]$/.test(s)) s = s.slice(0, -1);
    else if (s.endsWith("i")) s = `${s.slice(0, -1)}y`;
  }
  if (s.endsWith("e") && s.length > 3) s = s.slice(0, -1);
  return s;
}

const fold = (text: string): string => text.normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** The words of one whitespace-free chunk: its parts split at punctuation and at camelCase. */
const partsOf = (chunk: string): string[] =>
  fold(chunk).split(/[^\p{L}\p{N}]+/u).flatMap((p) => p.split(/(?<=\p{Ll})(?=\p{Lu})/u)).map((p) => p.toLowerCase()).filter(Boolean);

/**
 * The terms of a text, stemmed. With `compounds`, a chunk joined by punctuation or camelCase also
 * gives its parts run together — so the documents carry `pixeloffice` beside `pixel` and `office`,
 * and a query typed either way meets them. Queries are tokenized without it.
 */
export function terms(text: string, o: { compounds?: boolean; stop?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/\s+/)) {
    const parts = partsOf(chunk);
    for (const p of parts) if ((p.length > 1 || /\d/.test(p)) && !(o.stop && STOP.has(p))) out.push(stem(p));
    if (o.compounds && parts.length > 1 && parts.length <= 4) out.push(stem(parts.join("")));
  }
  return out;
}

/** The stemmed words in order, stop words and all, as one spaced string — what a phrase is matched in. */
const sequence = (text: string): string => ` ${terms(text).join(" ")} `;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const HEADING = /^#{1,6}\s+(.*)$/;

/** `key: value` lines of a leading `---` block, with the line each sits on; null when there is none. */
function frontmatter(lines: string[]): { end: number; fields: Map<string, { value: string; n: number }> } | null {
  if (lines[0]?.trim() !== "---") return null;
  const fields = new Map<string, { value: string; n: number }>();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return { end: i, fields };
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (m) fields.set(m[1]!.toLowerCase(), { value: m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2"), n: i + 1 });
  }
  return null;
}

function add(tf: Map<string, number>, ts: string[], weight: number): number {
  for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + weight);
  return ts.length;
}

const lineOf = (n: number, text: string, title = false): Line => ({ n, text, terms: new Set(terms(text, { compounds: true })), title });

/** One file as documents — see the module comment for what is one. */
export function parseFile(repo: string, path: string, content: string): Doc[] {
  const lines = content.split("\n");
  const isIndex = basename(path) === MEMORY_REPO_INDEX_FILE;
  const markdown = path.toLowerCase().endsWith(".md");
  const fm = markdown ? frontmatter(lines) : null;
  const from = fm ? fm.end + 1 : 0;
  const docs: Doc[] = [];
  const file: Doc = { repo, path, kind: "file", tf: new Map(), len: 0, seq: "", lines: [] };
  const seq: string[] = [];

  if (fm) {
    // The description first, so it is the snippet when it holds as much of the query as the name: a
    // Claude fact's name is often its file's slug, which the hit's path already shows.
    for (const key of ["description", "name"]) {
      const f = fm.fields.get(key);
      if (!f?.value) continue;
      file.len += add(file.tf, terms(f.value, { compounds: true }), W_TITLE);
      if (f.value !== basename(path).replace(/\.[A-Za-z0-9]+$/, "")) file.lines.push(lineOf(f.n, f.value, true));
      seq.push(f.value);
    }
  }
  if (!isIndex) file.len += add(file.tf, terms(path.replace(/\.[A-Za-z0-9]+$/, ""), { compounds: true }), W_PATH);
  let titled = file.lines.length > 0;
  for (let i = from; i < lines.length; i++) {
    const text = lines[i]!;
    if (text.trim() === "") continue;
    if (isIndex && LIST_ITEM.test(text)) {
      const entry: Doc = { repo, path, kind: "entry", tf: new Map(), len: 0, seq: sequence(text), lines: [lineOf(i + 1, text)] };
      entry.len = add(entry.tf, terms(text, { compounds: true }), W_INDEX);
      docs.push(entry);
      continue;
    }
    const heading = markdown ? HEADING.exec(text) : null;
    const title = heading !== null && !titled && !isIndex;
    if (title) titled = true;
    file.len += add(file.tf, terms(text, { compounds: true }), title ? W_TITLE : W_BODY);
    file.lines.push(lineOf(i + 1, text, title));
    seq.push(text);
  }
  if (file.len === 0) return docs;
  // Found by its path alone — a file with nothing but a slug for a name, or nothing in it yet: the hit
  // is its first line, or its path where it has none.
  if (file.lines.length === 0) file.lines.push(lineOf(1, lines.find((l) => l.trim() !== "")?.trim() ?? path));
  docs.push({ ...file, seq: sequence(seq.join("\n")) });
  return docs;
}

/** A parsed-file cache keyed on mtime and size, shared by every search a service makes. */
export class MemorySearch {
  private readonly files = new Map<string, Cached>();

  /** The best `limit` hits across `repos` for `query`, best first; ties go by repo, path and line. */
  search(repos: readonly string[], query: string, limit: number): SearchHit[] {
    const q = parseQuery(query);
    if (q.terms.length === 0) return [];
    const docs = repos.flatMap((r) => this.docsOf(r));
    if (docs.length === 0) return [];

    // Each query term's matches in the vocabulary, with their weight: itself whole, a prefix at half.
    const vocab = new Set<string>();
    for (const d of docs) for (const t of d.tf.keys()) vocab.add(t);
    const expansions = q.terms.map((qt) => {
      const m = new Map<string, number>();
      for (const t of vocab) {
        if (t === qt) m.set(t, 1);
        else if ((qt.length >= PREFIX_MIN && t.startsWith(qt)) || (t.length >= PREFIX_MIN && qt.startsWith(t))) m.set(t, PREFIX_WEIGHT);
      }
      return m;
    });
    const wtf = (d: Doc, e: Map<string, number>): number => {
      let n = 0;
      for (const [t, w] of e) { const f = d.tf.get(t); if (f) n += w * f; }
      return n;
    };
    const avg = { entry: 0, file: 0 };
    const count = { entry: 0, file: 0 };
    for (const d of docs) { avg[d.kind] += d.len; count[d.kind]++; }
    for (const k of ["entry", "file"] as const) avg[k] = count[k] > 0 ? avg[k] / count[k] : 1;
    const idf = expansions.map((e) => {
      const df = docs.filter((d) => wtf(d, e) > 0).length;
      return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
    });

    const hits: SearchHit[] = [];
    for (const d of docs) {
      let score = 0;
      expansions.forEach((e, i) => {
        const f = wtf(d, e);
        if (f > 0) score += idf[i]! * (f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / (avg[d.kind] || 1)));
      });
      if (score <= 0) continue;
      const phrases = q.phrases.filter((p) => d.seq.includes(p)).length;
      score *= 1 + PHRASE_BOOST * phrases;
      const best = bestLine(d, expansions, idf, q.phrases);
      hits.push({ repo: d.repo, path: d.path, line: best.n, text: snippet(best.text, best.terms, expansions), score });
    }
    hits.sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path) || a.line - b.line);
    return hits.slice(0, limit);
  }

  /** Every document of one repo, from the cache where the file has not changed. */
  private docsOf(repo: string): Doc[] {
    const docs: Doc[] = [];
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === ".git" || e.isSymbolicLink()) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!e.isFile()) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.size > FILE_MAX) continue;
        seen.add(abs);
        const held = this.files.get(abs);
        if (held && held.mtimeMs === st.mtimeMs && held.size === st.size) { docs.push(...held.docs); continue; }
        let parsed: Doc[] = [];
        try {
          const buf = readFileSync(abs);
          // Binary is not memory anyone reads as text.
          if (!buf.subarray(0, 8000).includes(0)) parsed = parseFile(repo, relative(repo, abs).split(sep).join("/"), buf.toString("utf8"));
        } catch { /* gone between the listing and the read */ }
        this.files.set(abs, { mtimeMs: st.mtimeMs, size: st.size, docs: parsed });
        docs.push(...parsed);
      }
    };
    walk(repo);
    // A file deleted since the last search leaves the cache with it.
    const root = repo.endsWith(sep) ? repo : `${repo}${sep}`;
    for (const abs of this.files.keys()) if (abs.startsWith(root) && !seen.has(abs)) this.files.delete(abs);
    return docs;
  }
}

/** The query's terms (stop words dropped unless nothing else is left) and its phrases: each "quoted"
 *  part, and the whole query when it is more than one word. */
function parseQuery(query: string): { terms: string[]; phrases: string[] } {
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const all = terms(query);
  const kept = terms(query, { stop: true });
  const phrases = [...new Set([...quoted, query].map((p) => terms(p)).filter((ts) => ts.length > 1).map((ts) => ` ${ts.join(" ")} `))];
  return { terms: [...new Set(kept.length > 0 ? kept : all)], phrases };
}

/** The line of a document that holds the most of the query: the summed idf of the terms it matches,
 *  a phrase counting double; a title line wins a tie, then the earlier line. */
function bestLine(d: Doc, expansions: Map<string, number>[], idf: number[], phrases: string[]): Line {
  let best = d.lines[0]!;
  let top = -1;
  for (const l of d.lines) {
    let s = 0;
    expansions.forEach((e, i) => { for (const [t, w] of e) if (l.terms.has(t)) { s += idf[i]! * w; break; } });
    if (s > 0) for (const p of phrases) if (sequence(l.text).includes(p)) s *= 2;
    if (s > top || (s === top && l.title && !best.title)) { best = l; top = s; }
  }
  return best;
}

/** The line, trimmed, and — past `SNIPPET_MAX` — a window of it around the first word the query matched. */
function snippet(text: string, lineTerms: Set<string>, expansions: Map<string, number>[]): string {
  const line = text.trim();
  if (line.length <= SNIPPET_MAX) return line;
  let at = 0;
  for (const m of line.matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = stem(fold(m[0]).toLowerCase());
    if (lineTerms.has(t) && expansions.some((e) => e.has(t))) { at = m.index ?? 0; break; }
  }
  const start = Math.max(0, Math.min(at - 80, line.length - (SNIPPET_MAX - 2)));
  const body = line.slice(start, start + SNIPPET_MAX - 2).trim();
  return `${start > 0 ? "…" : ""}${body}${start + SNIPPET_MAX - 2 < line.length ? "…" : ""}`;
}
