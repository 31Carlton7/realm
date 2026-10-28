import { MEMORY_REPO_INDEX_FILE } from "@realm/contracts";

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

/** One block competing for the budget. `priority` is lower for the more specific block, which gives
 *  way last. `pointer` is the line that says where the rest is, shown when the block is cut. `cut`
 *  says the text is already short of the whole (a read cap upstream), so it needs its pointer even if
 *  all of it fits here. */
export type BudgetBlock = { priority: number; cap: number; text: string; pointer: string; cut?: boolean };
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
    const text = b.cut && b.text.length + b.pointer.length <= room ? b.text : cutAtLine(b.text, room - b.pointer.length);
    out[i] = { text, cut: true };
    left -= text.length + b.pointer.length;
  });
  return out;
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
export type RepoIndexLike = { scope: "profile" | "space"; kind?: "root" | "spaceFolder"; path: string; index: string; truncated: boolean };

/**
 * The repos' indexes fitted to `MEMORY_INDEX_BUDGET`: the space folder's first, then a team repo's,
 * then the profile's root — the most specific gives way last. Each entry comes back with `index` cut
 * to what fits and `truncated` set where anything is missing, so the block that renders it adds
 * `readRestPointer` — the line this budget held room for.
 */
export function budgetRepoIndexes<T extends RepoIndexLike>(indexes: readonly T[], total = MEMORY_INDEX_BUDGET): T[] {
  const fitted = fitBlocks(indexes.map((r) => {
    const folder = r.kind === "spaceFolder";
    return {
      priority: folder ? 0 : r.scope === "space" ? 1 : 2,
      cap: folder ? SPACE_FOLDER_INDEX_CAP : r.scope === "space" ? TEAM_INDEX_CAP : PROFILE_INDEX_CAP,
      text: r.index, pointer: readRestPointer(r), cut: r.truncated,
    };
  }), total);
  return indexes.map((r, i) => ({ ...r, index: fitted[i]!.text, truncated: fitted[i]!.cut }));
}

/**
 * The line under a cut index that says how to read the rest: `memory_read` with the file and the
 * repo, which works whether the session has one repo or two.
 */
export function readRestPointer(r: Pick<RepoIndexLike, "scope" | "kind" | "path">): string {
  if (r.kind !== "spaceFolder") return `That MEMORY.md is longer than this; \`memory_read\` MEMORY with \`repo: "${r.scope}"\` for the rest.`;
  const folder = spaceFolderOf(r.path);
  return folder
    ? `This space's MEMORY.md is longer than this; \`memory_read\` ${folder}/MEMORY with \`repo: "${r.scope}"\` for the rest.`
    : `This space's MEMORY.md is longer than this; \`memory_read\` spaces with \`repo: "${r.scope}"\` lists the space folders, and this space's has the rest.`;
}

/** `spaces/<folder>` from a space folder entry's path — the folder itself or its MEMORY.md — or null
 *  for a path that does not name one. */
function spaceFolderOf(path: string): string | null {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  if (parts.at(-1) === MEMORY_REPO_INDEX_FILE) parts.pop();
  return parts.length >= 2 && parts.at(-2) === "spaces" && parts.at(-1) ? `spaces/${parts.at(-1)}` : null;
}
