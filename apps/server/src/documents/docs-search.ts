import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SearchSnippet } from "@realm/contracts";
import { liveMatches, liveSnippet, queryTokens } from "../search/service";
import { relInRoot, resolveInRoot } from "./paths";
import { isExtractable, type TextExtractor } from "./text-extract";

/**
 * `docs_search` (Plan 22 W2): find the files in a checkout that mention every word of a query,
 * ranked, each with a snippet.
 *
 * LIVE, not indexed — the same stance the global search takes for skills and memory docs and for the
 * same reason: these are files the user edits in Finder, that agents rewrite, that git checks out
 * from under any index. A course folder is dozens to a few hundred files, and PDF text (the only
 * expensive part) is memoized by the extractor, so a scan is the honest and the fast option.
 *
 * Ranking is deliberately simple and explainable: a file scores by how often the query's tokens
 * occur, with a bonus for a token in the path (a lecture titled "pipelining" beats a lecture that
 * mentions pipelining once), normalised a little for length so a 200-page textbook does not win
 * every search by sheer mass.
 */

/** Directories never descended into — the document picker's list plus what a course folder tends
 *  to accumulate that is not course material. */
export const SKIP_DIRS = new Set([".git", "node_modules", "dist", "out", "build", ".next", ".turbo", "target", "__pycache__", ".venv", "venv", ".cache", "Pods", "DerivedData"]);
export const SEARCH_MAX_FILES = 3000;
export const SEARCH_MAX_DEPTH = 8;
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 30;

export type DocHit = { path: string; score: number; snippet: SearchSnippet; kind: "pdf" | "text" };
export type DocSearchResult = { hits: DocHit[]; scanned: number; truncated: boolean };

/** Every extractable file under `root/dir`, relative `/`-paths, bounded by count and depth. */
export async function walkFiles(root: string, dir = ""): Promise<{ files: string[]; truncated: boolean }> {
  const start = resolveInRoot(root, dir);
  const files: string[] = [];
  let truncated = false;
  const visit = async (abs: string, depth: number): Promise<void> => {
    if (files.length >= SEARCH_MAX_FILES) { truncated = true; return; }
    let names: string[];
    try { names = await readdir(abs, { withFileTypes: true }).then((es) => es.filter((e) => !e.name.startsWith(".")).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))); }
    catch { return; }
    names.sort();
    for (const n of names) {
      if (files.length >= SEARCH_MAX_FILES) { truncated = true; return; }
      if (n.endsWith("/")) {
        const name = n.slice(0, -1);
        if (SKIP_DIRS.has(name) || depth >= SEARCH_MAX_DEPTH) continue;
        await visit(join(abs, name), depth + 1);
      } else if (isExtractable(n)) {
        const rel = relInRoot(root, join(abs, n));
        if (rel !== null) files.push(rel);
      }
    }
  };
  await visit(start, 0);
  return { files, truncated };
}

export async function searchDocs(
  root: string, query: string, extractor: TextExtractor,
  o: { dir?: string; limit?: number } = {},
): Promise<DocSearchResult> {
  const tokens = queryTokens(query);
  const limit = Math.max(1, Math.min(o.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT));
  if (tokens.length === 0) return { hits: [], scanned: 0, truncated: false };
  const { files, truncated } = await walkFiles(root, o.dir ?? "");
  const hits: DocHit[] = [];
  for (const rel of files) {
    let text: string | null;
    try { text = await extractor.text(resolveInRoot(root, rel)); } catch { continue; }
    if (text === null || !liveMatches(text, tokens)) {
      // A path-only match (every token in the filename) is still a hit: "find the pipelining
      // lecture" should work on a scanned PDF whose text layer is empty.
      if (!liveMatches(rel, tokens)) continue;
      hits.push({ path: rel, score: 1, snippet: [{ text: rel, match: true }], kind: rel.toLowerCase().endsWith(".pdf") ? "pdf" : "text" });
      continue;
    }
    hits.push({ path: rel, score: scoreOf(rel, text, tokens), snippet: liveSnippet(text, tokens), kind: rel.toLowerCase().endsWith(".pdf") ? "pdf" : "text" });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { hits: hits.slice(0, limit), scanned: files.length, truncated };
}

/** Occurrences per token, length-damped, plus a flat bonus per token found in the path. */
export function scoreOf(rel: string, text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  const path = rel.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    let n = 0;
    for (let at = lower.indexOf(t); at !== -1 && n < 200; at = lower.indexOf(t, at + t.length)) n++;
    score += Math.log1p(n);
    if (path.includes(t)) score += 2;
  }
  // Damp very long documents a little: a token that appears 50 times in 500 kB is less "about" it
  // than one appearing 10 times in 2 kB.
  return score / Math.log10(Math.max(10, lower.length / 100));
}
