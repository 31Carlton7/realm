import { z } from "zod";
import { SEARCH_QUERY_MAX, SearchSnippetSchema } from "./search";

/**
 * Searching a **checkout** — the files an environment points at — rather than Realm's own records.
 *
 * `search.query` answers "where did I discuss this": transcripts and item titles, out of an index the
 * server owns. This answers the two questions an editor is asked instead — "open that file" and
 * "where is this string in the code" — and neither can be indexed here, because the checkout is a
 * working tree that git, the user's own editor and every agent rewrite underneath us. So both run
 * LIVE against git, and the whole design is about what they are allowed to cost (see the bounds in
 * `apps/server/src/workspace/grep.ts`, which are the ones that talk to the process, and the two
 * below, which are the ones that talk to the palette).
 *
 * Both answers carry `SearchSnippet` segments. That is not a coincidence of shape: the palette has
 * ONE snippet renderer and these rows sit in the same list as transcript hits, so a second markup
 * would be a second way for the same list to draw the same thing.
 */

/** A file-name query is a path fragment, so it shares the palette's ceiling rather than inventing a
 *  second one; the ranker is O(query) per candidate and does not care. */
export const PROJECT_QUERY_MAX = SEARCH_QUERY_MAX;

/**
 * How many ranked file names come back. The palette draws every row it is given, so this is a DOM
 * bound: the ranker happily orders forty thousand paths, and the twentieth is already past the point
 * where anyone reads rather than types another character.
 */
export const PROJECT_FILES_LIMIT = 20;
export const PROJECT_FILES_LIMIT_MAX = 50;

/**
 * How many candidate paths the ranker will look at before it stops. This is the CPU bound, and it is
 * the reason the ranker may be called synchronously from a keystroke: matching is a subsequence test
 * plus at most `MAX_STARTS` greedy passes over a path, so the worst case here is a few million
 * character comparisons — a monorepo checkout, not a pathological one. `git ls-files` on a kernel
 * tree returns more than this, and the honest answer for that case is a truncated candidate set with
 * `truncated: true` rather than a palette that stops answering the keyboard.
 */
export const PROJECT_FILES_MAX_CANDIDATES = 20_000;

export const ProjectFileHitSchema = z.object({
  /** Repo-relative, `/`-separated — the same path `documents.openPath` takes. */
  path: z.string(),
  /** The ranker's own number. Sent so a client can merge two rankings (a future "recent files" list)
   *  without re-deriving it, never rendered. */
  score: z.number(),
  /** The path with the matched characters marked, so the palette can show WHY a row is there. */
  segments: SearchSnippetSchema,
});
export type ProjectFileHit = z.infer<typeof ProjectFileHitSchema>;

/** `truncated` means the CANDIDATE list was cut, so a better match may exist and was never scored —
 *  a different and more honest claim than "there were more rows than you asked for". */
export const ProjectFileListSchema = z.object({
  paths: z.array(z.string()),
  truncated: z.boolean(),
  /** How the list was obtained. `walk` is the not-a-git-repository fallback, and the palette says so
   *  rather than silently returning a worse answer under the same label. */
  source: z.enum(["git", "walk"]),
});
export type ProjectFileList = z.infer<typeof ProjectFileListSchema>;

export const ProjectFilesResultSchema = z.object({
  hits: z.array(ProjectFileHitSchema),
  truncated: z.boolean(),
  source: z.enum(["git", "walk"]),
});
export type ProjectFilesResult = z.infer<typeof ProjectFilesResultSchema>;

/**
 * Rows a content search may return, and the ceiling the service enforces. One pair of numbers rather
 * than a wire default and a server cap that could disagree: the RPC schema clamps the request here
 * and `ProjectSearchService` treats the maximum as its own hard stop, so a caller cannot ask for
 * more than the service would ever have produced.
 *
 * The default is smaller than the ceiling because the palette is read, not paged — a hundred rows is
 * already past where anyone scrolls, and the answer to "too many results" is another word in the
 * query, not another screen.
 */
export const PROJECT_GREP_LIMIT = 100;
export const PROJECT_GREP_LIMIT_MAX = 200;

export const ProjectGrepHitSchema = z.object({
  path: z.string(),
  /** 1-based, the way git grep and every editor count. */
  line: z.number().int().positive(),
  /** The matching line, clipped, with the matched runs marked. */
  segments: SearchSnippetSchema,
});
export type ProjectGrepHit = z.infer<typeof ProjectGrepHitSchema>;

export const ProjectGrepResultSchema = z.object({
  hits: z.array(ProjectGrepHitSchema),
  /** A cap was hit — total, per-file, or the timeout. The palette shows "first N" rather than
   *  implying these are all of them. */
  truncated: z.boolean(),
  source: z.enum(["git", "walk"]),
});
export type ProjectGrepResult = z.infer<typeof ProjectGrepResultSchema>;

// ---------------------------------------------------------------------------------------------------
// The ranker
//
// Ordering IS the product here. A file-name search that returns the right file fourth is a search the
// user stops trusting and replaces with a folder tree, so the rules below are stated as constants a
// test can move rather than as a hand-tuned expression.

/** Every matched character is worth something, so a longer match beats a shorter one all else equal. */
const BASE = 1;
/** The character starts a path segment or a word inside one (`/`, `-`, `_`, `.`, a camel hump, a digit
 *  run). This is the single strongest signal: typing "dp" means DocumentsPane far more often than it
 *  means the `d` and `p` that happen to fall inside "deprecated". */
const BOUNDARY = 16;
/** Directly after the previous match. Worth much less than a boundary but much more than nothing:
 *  "search" as a substring beats "s…e…a…r…c…h" scattered across a path. */
const CONSECUTIVE = 8;
/** The typed character agreed in case. Small — it only ever breaks ties — because a user who types
 *  all-lowercase must not be punished, and one who types `Pane` should get `Pane` before `pane`. */
const CASE = 2;
/** Per character skipped before the first match and between matches. Capped, or a single match deep
 *  inside a long vendored path would score below zero and sort under things that did not match at
 *  all after the length tie-break. */
const GAP = 1;
const GAP_CAP = 12;
/**
 * The whole query matched inside the FILE NAME rather than somewhere across the path. Large enough to
 * beat any realistic directory match, because "rpc" means `rpc.ts` and not the four other files that
 * live in a directory called `rpc/`.
 */
const BASENAME = 40;
/**
 * How many starting positions the greedy matcher will try. Greedy-from-the-first-occurrence gets "rpc"
 * against `apps/server/src/rpc/methods.ts` wrong — it spends the `r` on "server" and then cannot see the
 * contiguous "rpc" two segments later. Retrying from each later occurrence of the first character
 * fixes that; capping the retries is what keeps the whole ranker linear-ish in practice, and 8 is
 * past the point where another attempt has ever changed the winner on a real path.
 */
const MAX_STARTS = 8;

type FuzzyMatch = { score: number; positions: number[] };

const isUpper = (c: string) => c >= "A" && c <= "Z";
const isLower = (c: string) => c >= "a" && c <= "z";
const isDigit = (c: string) => c >= "0" && c <= "9";

/** A word start: the beginning, anything after a separator, a camel hump, or the start of a digit run. */
export function isWordBoundary(text: string, i: number): boolean {
  if (i <= 0) return true;
  const prev = text[i - 1]!, cur = text[i]!;
  if (prev === "/" || prev === "\\" || prev === "-" || prev === "_" || prev === "." || prev === " ") return true;
  if (isUpper(cur) && isLower(prev)) return true;
  return isDigit(cur) && !isDigit(prev);
}

/** Cheap reject: is `query` a subsequence of `text` at all? Run once per candidate so the expensive
 *  multi-start scoring only ever sees paths that can actually match. */
function isSubsequence(text: string, query: string): boolean {
  let ti = -1;
  for (const ch of query) {
    ti = text.indexOf(ch, ti + 1);
    if (ti === -1) return false;
  }
  return true;
}

/**
 * Best greedy alignment of `query` inside `text`, or null. Case-insensitive to match, case-sensitive
 * only to score.
 *
 * Deliberately not a full Smith-Waterman: the optimal alignment is a `query × text` table per
 * candidate, which is the difference between ranking a checkout on a keystroke and not. The
 * multi-start greedy below finds the same answer on every path shape this has been tested against.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  if (query === "") return { score: 0, positions: [] };
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  if (!isSubsequence(lower, q)) return null;

  let best: FuzzyMatch | null = null;
  let start = lower.indexOf(q[0]!);
  for (let tries = 0; start !== -1 && tries < MAX_STARTS; tries++, start = lower.indexOf(q[0]!, start + 1)) {
    const positions: number[] = [start];
    let ti = start;
    let ok = true;
    for (let qi = 1; qi < q.length; qi++) {
      ti = lower.indexOf(q[qi]!, ti + 1);
      if (ti === -1) { ok = false; break; }
      positions.push(ti);
    }
    // Every later start is further right, so once one runs out of text they all do.
    if (!ok) break;
    const score = scoreAlignment(text, query, positions);
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

function scoreAlignment(text: string, query: string, positions: number[]): number {
  let score = 0;
  let prev = -2;
  for (let k = 0; k < positions.length; k++) {
    const i = positions[k]!;
    score += BASE;
    // A character that both follows the previous match AND starts a word takes the larger of the two
    // rather than both: they are two descriptions of the same good outcome, not two outcomes.
    if (isWordBoundary(text, i)) score += BOUNDARY;
    else if (i === prev + 1) score += CONSECUTIVE;
    if (text[i] === query[k]) score += CASE;
    score -= Math.min(k === 0 ? i : i - prev - 1, GAP_CAP) * GAP;
    prev = i;
  }
  return score;
}

/** Alternating plain/matched segments over `text`, given sorted match positions. */
export function markPositions(text: string, positions: number[]): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  let i = 0;
  for (let k = 0; k < positions.length;) {
    const start = positions[k]!;
    let end = start + 1;
    while (k + 1 < positions.length && positions[k + 1] === end) { end++; k++; }
    k++;
    if (start > i) out.push({ text: text.slice(i, start), match: false });
    out.push({ text: text.slice(start, end), match: true });
    i = end;
  }
  if (i < text.length) out.push({ text: text.slice(i), match: false });
  return out;
}

/**
 * One path's best match: the file name if the query fits in it, otherwise the whole path.
 *
 * The two are scored separately rather than by boosting positions that happen to land past the last
 * slash, because the bonuses are positional: in `packages/contracts/src/rpc.ts` the `r` of `rpc` is a
 * word boundary when the basename is measured on its own and an ordinary interior character when the
 * whole path is, and only the first of those is the fact a person means by typing "rpc".
 */
export function matchPath(path: string, query: string): FuzzyMatch | null {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const inBase = fuzzyMatch(base, query);
  const inPath = fuzzyMatch(path, query);
  const shifted: FuzzyMatch | null = inBase
    ? { score: inBase.score + BASENAME, positions: slash === -1 ? inBase.positions : inBase.positions.map((i) => i + slash + 1) }
    : null;
  if (!shifted) return inPath;
  if (!inPath) return shifted;
  return shifted.score >= inPath.score ? shifted : inPath;
}

/**
 * Rank `paths` against a file-name query, best first, capped at `limit`.
 *
 * Pure, and exported from contracts rather than kept in the server, so the ordering can be tested
 * against a table of paths instead of against a process — and so a client that already holds a file
 * list (the open tabs, a recent-files list) can order it by the same rules the palette does.
 *
 * An EMPTY query is the list itself, unranked and unreordered: ⌘P before a keystroke should show
 * what git already had at the top of `ls-files`, not a fabricated ranking of nothing.
 *
 * Ties break by path length, then alphabetically. Both halves matter: the shorter of two equal
 * matches is nearly always the one meant (`src/index.ts` over `src/a/b/c/index.ts`), and a total
 * order is what stops the palette from reshuffling identical rows between keystrokes.
 */
export function rankPaths(paths: readonly string[], query: string, limit: number = PROJECT_FILES_LIMIT): ProjectFileHit[] {
  const q = query.trim();
  const cap = Math.max(0, Math.min(limit, PROJECT_FILES_LIMIT_MAX));
  if (q === "") {
    return paths.slice(0, cap).map((path) => ({ path, score: 0, segments: [{ text: path, match: false }] }));
  }
  const scored: ProjectFileHit[] = [];
  for (const path of paths) {
    const m = matchPath(path, q);
    if (!m) continue;
    scored.push({ path, score: m.score, segments: markPositions(path, m.positions) });
  }
  scored.sort((a, b) =>
    b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return scored.slice(0, cap);
}
