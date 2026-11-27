import { MEMORY_REPO_INDEX_FILE } from "@realm/contracts";
import { MemorySearch, terms } from "./search";

/**
 * How much of what AGENTS wrote travels into every session, and which part gives way first.
 *
 * The user's own space and profile documents are not in here: they are standing instructions the user
 * wrote and capped themselves (`MEMORY_DOC_MAX`, `MEMORY_COMBINED_MAX`), and they keep those rules. This
 * is the budget for the memory repos' indexes — text agents wrote, which grows by itself.
 *
 * The numbers, in characters (a token is about four):
 *
 * - **A space folder's index, 20,000.** `spaces/<folder>/MEMORY.md`, Claude's own format: one
 *   `- [Title](file.md) — hook` line per fact. Of the per-project indexes Claude has written on the
 *   owner's Mac, the Realm project's is 73 lines and 13 KB and the largest 82 lines and 17.5 KB, so
 *   every one of them rides whole, with room to grow by a dozen or so lines. It matches the per-repo
 *   read cap (`MEMORY_REPO_INDEX_MAX`).
 * - **A team repo's root index, 8,000; the profile's root index, 8,000.** The Agent Memory Repo spec
 *   asks for a short MEMORY.md, and these are: the two team repos here are 259 and 70 characters. The
 *   profile root holds profile-wide facts plus one `[[spaces/<folder>/MEMORY]]` link per space (17
 *   spaces is about 700 characters), so 8,000 is about forty one-line facts beside the links.
 * - **The total, 28,000 (about 7,000 tokens).** A space folder's cap plus the profile root's: a space
 *   with no team repo — every space but two on this Mac — never loses a line its own caps allowed. A
 *   team repo on top is when the blocks compete, and then the more specific one wins. The old ceiling
 *   was `MEMORY_COMBINED_MAX`, 150,000 characters — about 37,000 tokens of every turn's prompt, most of
 *   it read on every request whether or not the task touched it. The index is the hook list; the rest
 *   is one `memory_read` or `memory_search` away.
 */
export const MEMORY_INDEX_BUDGET = 28_000;
export const SPACE_FOLDER_INDEX_CAP = 20_000;
export const TEAM_INDEX_CAP = 8_000;
export const PROFILE_INDEX_CAP = 8_000;

/**
 * What a save may add to an index, and when it says the index is getting long. These are checked
 * where entries are written; the caps above only cut what a session is handed.
 *
 * - **One index line, 200.** A save whose line would run longer writes a hook this long at most to
 *   MEMORY.md and the whole entry to a fact file it links (`MemoryRepoService.edit`). Root entries had
 *   reached a median of 357 characters and a longest of 735, so the profile root fit 21 of its 53.
 * - **A warning at 180 lines or 18,000 characters.** Claude's own auto-memory loads the first 200
 *   lines of an index, and `SPACE_FOLDER_INDEX_CAP` cuts at 20,000 characters: the warning comes a
 *   tenth before either, while there is still room to tidy. It never refuses the save.
 */
export const INDEX_LINE_MAX = 200;
export const INDEX_WARN_LINES = 180;
export const INDEX_WARN_CHARS = 18_000;
/**
 * The share of a cut index's room its first lines keep, whole and in order; the rest goes to the lines
 * after them that rank highest for what the session is about (`indexQuery`). Half, because the top of
 * an index is where its owner puts what every session needs, and what is past it was written later,
 * not less.
 */
export const INDEX_HEAD_SHARE = 0.5;
/** How much of one index the ranking chooses from: ten caps' worth, so a long index's tail is read
 *  instead of cut at the cap before anything is ranked. */
export const INDEX_READ_MAX = 10 * SPACE_FOLDER_INDEX_CAP;

/** What a session's indexes are ranked against: its first prompt, or its title while it has none. "" —
 *  no ranking, the index cut at a line as it always was — when it has neither. */
export function indexQuery(firstPrompt: string | null | undefined, title: string | null | undefined): string {
  return firstPrompt?.trim() || title?.trim() || "";
}

/**
 * How much of an index Claude's auto-memory loads, and drops the rest of: the text trimmed, its first
 * 200 lines, and of those at most 25,000 characters, cut back to a line break. These are the CLI's own
 * numbers, read from the 0.3.322 binary the SDK ships, and its warning says the same: "MEMORY.md is
 * 222 lines (limit: 200). Only part of it was loaded: 22 of 222 lines were cut off, starting at line 201".
 */
export const CLAUDE_INDEX_LINES = 200;
export const CLAUDE_INDEX_CHARS = 25_000;

/**
 * The lines of `index` that Claude's auto-memory does not load, in order and without blank ones — none
 * when it loads the whole index. A line the character cap cuts in two is left out, as is the last line
 * when `partial` says a read cap may have cut it short.
 */
export function claudeUnloadedLines(index: string, partial = false): string[] {
  const text = index.trim();
  let loaded = text.split("\n").slice(0, CLAUDE_INDEX_LINES).join("\n");
  if (loaded.length > CLAUDE_INDEX_CHARS) {
    const at = loaded.lastIndexOf("\n", CLAUDE_INDEX_CHARS);
    loaded = loaded.slice(0, at > 0 ? at : CLAUDE_INDEX_CHARS);
  }
  const rest = text.slice(loaded.length).split("\n");
  // The first piece is what is left of the last line loaded: "" when the cut fell at a line break.
  rest.shift();
  if (partial) rest.pop();
  return rest.filter((l) => l.trim() !== "");
}

/** What a save tells the agent once `index` (an index's whole text, as the save left it) is at
 *  `INDEX_WARN_LINES` or `INDEX_WARN_CHARS`, or null while it is under both. */
export function indexWarning(file: string, index: string): string | null {
  const lines = index === "" ? 0 : index.replace(/\n$/, "").split("\n").length;
  const over = [
    lines >= INDEX_WARN_LINES ? `${lines} lines (the warning is at ${INDEX_WARN_LINES}; Claude loads the first ${CLAUDE_INDEX_LINES})` : null,
    index.length >= INDEX_WARN_CHARS ? `${index.length.toLocaleString("en-US")} characters (the warning is at ${INDEX_WARN_CHARS.toLocaleString("en-US")})` : null,
  ].filter((x) => x !== null);
  if (over.length === 0) return null;
  return `${file} is now ${over.join(" and ")}. Entries past the cut are not loaded into new sessions: merge entries that say the same thing, memory_remove ones that are no longer true, or move detail into topic files.`;
}

/** One block competing for the budget. `priority` is lower for the more specific block, which gives
 *  way last. `pointer` is the line that says where the rest is, shown when the block is cut. `cut`
 *  says the text is already short of the whole (a read cap upstream), so it needs its pointer even if
 *  all of it fits here. `query`, when it has words, is what a block that does not fit ranks its lines
 *  against past its head (`INDEX_HEAD_SHARE`). */
export type BudgetBlock = { priority: number; cap: number; text: string; pointer: string; cut?: boolean; query?: string };
/** What of one block fits: its text, whole or cut at a line, and whether it needs its pointer. */
export type FittedBlock = { text: string; cut: boolean };

/**
 * What of each block fits under one `total`, in the order the blocks were given.
 *
 * The most specific block (lowest `priority`; input order breaks ties) takes up to its cap first,
 * then the next, from what is left. A block that does not fit whole is cut at the last line break
 * that fits — never inside a line, where half an entry can read as a different fact — and costs its
 * pointer too. Room for the pointer of every block still to come is held back before each block takes
 * its share, so however the budget falls every block that is cut can still say where the rest is. So
 * long as `total` can hold every pointer, it is never exceeded: the text kept plus the pointers of the
 * cut blocks is at most `total`.
 */
export function fitBlocks(blocks: readonly BudgetBlock[], total: number): FittedBlock[] {
  const order = blocks.map((b, i) => ({ b, i })).sort((x, y) => x.b.priority - y.b.priority || x.i - y.i);
  const out: FittedBlock[] = blocks.map(() => ({ text: "", cut: false }));
  let left = total;
  order.forEach(({ b, i }, k) => {
    const held = order.slice(k + 1).reduce((n, o) => n + o.b.pointer.length, 0);
    const room = Math.max(0, Math.min(b.cap, left - held));
    if (!b.cut && b.text.length <= room) {
      out[i] = { text: b.text, cut: false };
      left -= b.text.length;
      return;
    }
    const max = room - b.pointer.length;
    const text = b.cut && b.text.length <= max ? b.text
      : b.query && terms(b.query).length > 0 ? fitRanked(b.text, max, b.query, b.cut === true)
      : cutAtLine(b.text, max);
    out[i] = { text, cut: true };
    left -= text.length + b.pointer.length;
  });
  return out;
}

/**
 * At most `max` of `text` in whole lines: its head up to `INDEX_HEAD_SHARE` of `max`, then the lines
 * after it that rank highest for `query`, then the rest in order while they fit. The lines kept stay
 * in the order the index has them. `partial` drops the last line, which a read cap may have cut short.
 */
function fitRanked(text: string, max: number, query: string, partial: boolean): string {
  const head = cutAtLine(text, Math.floor(max * INDEX_HEAD_SHARE));
  const lines = text.split("\n");
  if (partial) lines.pop();
  const from = head === "" ? 0 : head.split("\n").length;
  const tail = lines.slice(from);
  const order = rankedFirst(tail, query);
  let left = max - head.length;
  const kept = new Set<number>();
  for (const i of order) {
    const cost = tail[i]!.length + 1;
    if (tail[i]!.trim() === "" || cost > left) continue;
    kept.add(i);
    left -= cost;
  }
  return [head, ...tail.filter((_, i) => kept.has(i))].filter((l) => l !== "").join("\n");
}

/** The positions of `lines`, the ones that rank highest for `query` first and the rest after them in order. */
function rankedFirst(lines: readonly string[], query: string): number[] {
  const ranked = new MemorySearch().rankIndexLines(lines.join("\n"), query);
  const rankedSet = new Set(ranked);
  return [...ranked, ...lines.map((_, i) => i).filter((i) => !rankedSet.has(i))];
}

/** The lines of `text` reordered by `rankedFirst`. */
function inRankOrder(text: string, query: string): string {
  const lines = text.split("\n");
  return rankedFirst(lines, query).map((i) => lines[i]!).join("\n");
}

/** The longest start of `text` that ends at a line break and is at most `max` long — "" when not even
 *  the first line fits. */
function cutAtLine(text: string, max: number): string {
  if (max <= 0) return "";
  const at = text.lastIndexOf("\n", max);
  return at <= 0 ? "" : text.slice(0, at).trimEnd();
}

/**
 * A memory repo's index as one session receives it — `MemoryRepoService.indexesFor`'s entries.
 *
 * `kind` is the shape the memory-core work adds (`root` = the repo's own MEMORY.md, `spaceFolder` =
 * `spaces/<folder>/MEMORY.md` of the profile repo). Optional here so entries that do not carry it yet
 * read as the root index they are; the required field that replaces it satisfies this type as is.
 */
export type RepoIndexLike = { scope: "profile" | "space"; kind?: "root" | "spaceFolder"; path: string; index: string; truncated: boolean; claudeTail?: true };

/**
 * The repos' indexes fitted to `MEMORY_INDEX_BUDGET`: the space folder's first, then a team repo's,
 * then the profile's root — the most specific gives way last. Each entry comes back with `index` cut
 * to what fits and `truncated` set where anything is missing, so the block that renders it adds
 * `readRestPointer` — the line this budget held room for. With a `query` (`indexQuery`), what is cut
 * past an index's head is what ranked lowest for it, and `ranked` says so.
 *
 * A `claudeTail` entry is only the lines Claude's auto-memory left out (`claudeUnloadedLines`): it has
 * no head of its own to keep, so all of it is put in rank order, and what does not fit is the lowest.
 */
export function budgetRepoIndexes<T extends RepoIndexLike>(indexes: readonly T[], total = MEMORY_INDEX_BUDGET, query = ""): (T & { ranked: boolean })[] {
  const ranked = terms(query).length > 0;
  const fitted = fitBlocks(indexes.map((r) => {
    const folder = r.kind === "spaceFolder";
    return {
      priority: folder ? 0 : r.scope === "space" ? 1 : 2,
      cap: folder ? SPACE_FOLDER_INDEX_CAP : r.scope === "space" ? TEAM_INDEX_CAP : PROFILE_INDEX_CAP,
      text: r.claudeTail ? inRankOrder(r.index, query) : r.index,
      pointer: readRestPointer({ ...r, ranked }), cut: r.truncated, query: r.claudeTail ? "" : query,
    };
  }), total);
  return indexes.map((r, i) => ({ ...r, index: fitted[i]!.text, truncated: fitted[i]!.cut, ranked: ranked && fitted[i]!.cut }));
}

/**
 * The line under a cut index that says how to read the rest: `memory_read` with the file and the
 * repo, which works whether the session has one repo or two. A `ranked` cut says which lines were left
 * out: past its first lines, the ones that ranked lowest for this session.
 */
export function readRestPointer(r: Pick<RepoIndexLike, "scope" | "kind" | "path"> & { ranked?: boolean }): string {
  const which = r.ranked ? "; past its first lines, the entries shown are the ones that rank highest for this session's first prompt (or its title), and the rest were ranked out" : "";
  if (r.kind !== "spaceFolder") return `That MEMORY.md is longer than this${which}; \`memory_read\` MEMORY with \`repo: "${r.scope}"\` for the rest.`;
  const folder = spaceFolderOf(r.path);
  return folder
    ? `This space's MEMORY.md is longer than this${which}; \`memory_read\` ${folder}/MEMORY with \`repo: "${r.scope}"\` for the rest.`
    : `This space's MEMORY.md is longer than this${which}; \`memory_read\` spaces with \`repo: "${r.scope}"\` lists the space folders, and this space's has the rest.`;
}

/** `spaces/<folder>` from a space folder entry's path — the folder itself or its MEMORY.md — or null
 *  for a path that does not name one. */
function spaceFolderOf(path: string): string | null {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  if (parts.at(-1) === MEMORY_REPO_INDEX_FILE) parts.pop();
  return parts.length >= 2 && parts.at(-2) === "spaces" && parts.at(-1) ? `spaces/${parts.at(-1)}` : null;
}
