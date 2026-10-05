import type { Checkpoint, TurnChanges, TurnFile } from "@realm/contracts";
import { fileDiffsFor, isUnifiedDiff, parseUnifiedDiff } from "./rich/diff";
import { blockKey, type Block } from "./transcript-model";
import { normalizePath } from "./file-links";

/** One file a turn changed, as the card lists it. */
export type EditedFile = {
  /** Absolute — what a click opens. */
  path: string;
  /** Relative to the checkout's root — what the row says. */
  shown: string;
  oldShown: string | null;
  status: TurnFile["status"];
  /** Null when nobody can say: a binary file, or a file the agent rewrote whole with no checkpoint to
   *  compare against. A number is only ever one that was measured. */
  additions: number | null;
  deletions: number | null;
};

/** One turn's edits: the card under its run line. */
export type TurnEdits = {
  files: EditedFile[];
  /** The true count, when the measurement listed fewer. */
  totalFiles: number;
  /** `git` when the server measured the checkout at the settle; `tools` when only the agent's own edit
   *  calls say what changed — a folder with no checkpoints, a message steered into a running turn. */
  source: "git" | "tools";
  /** The `turn` checkpoint captured in front of this turn, if Realm took one. */
  checkpointId: string | null;
  /** The measured "after", for Review. Null on a turn only its tool calls describe. */
  afterTree: string | null;
  root: string;
  /** The message that started the turn — how a review of it is named. Null for a turn no message
   *  of the user's started. */
  asked: string | null;
};

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]);

/**
 * Claude's `Write` result for a file that did not exist — the one case a `Write` states its whole
 * effect: every line is new. Over an existing file it states the new text and nothing about what it
 * replaced, so its counts are unknown and are left so.
 */
const CREATED = /^File created successfully/;

const rel = (path: string, root: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);

function measured(c: TurnChanges, asked: string | null): TurnEdits {
  const root = c.root.replace(/\/+$/, "");
  return {
    files: c.files.map((f) => ({
      path: `${root}/${f.path}`, shown: f.path, oldShown: f.oldPath, status: f.status, additions: f.additions, deletions: f.deletions,
    })),
    totalFiles: c.totalFiles, source: "git", checkpointId: c.checkpointId, afterTree: c.afterTree, root, asked,
  };
}

/** Whether an ACP call's result is the unified diff its edit was drawn as (map-acp.ts). */
const acpEdit = (b: Extract<Block, { kind: "tool" }>) => b.toolKind === "edit" && !!b.result && isUnifiedDiff(b.result.content);

/** A settled call's diff, worked out once: from its own two sides (Claude, Codex), or from the diff
 *  an ACP agent's result carries. The reducer keeps every settled block's object, so a transcript
 *  re-derived on each streaming delta finds the answer here instead of re-diffing every edit. */
const diffsOf = new WeakMap<object, ReturnType<typeof fileDiffsFor>>();
function callDiffs(b: Extract<Block, { kind: "tool" }>): ReturnType<typeof fileDiffsFor> {
  if (!diffsOf.has(b)) diffsOf.set(b, acpEdit(b) ? parseUnifiedDiff(b.result!.content, b.paths?.[0] ?? "") : fileDiffsFor(b.name, b.input));
  return diffsOf.get(b)!;
}

/** What a turn's own edit calls say it changed — only the calls that landed, and a count only where
 *  the call carries both sides of the change. */
function fromTools(tools: readonly Extract<Block, { kind: "tool" }>[], cwd: string, root: string): EditedFile[] {
  const byPath = new Map<string, EditedFile>();
  for (const b of tools) {
    if (!b.result || b.result.isError || !(EDIT_TOOLS.has(b.name) || acpEdit(b))) continue;
    for (const d of callDiffs(b) ?? []) {
      if (!d.path) continue;
      const path = normalizePath(d.path.startsWith("/") ? d.path : `${cwd}/${d.path}`);
      if (!path) continue;
      const created = (b.name === "Write" && CREATED.test(b.result.content)) || (acpEdit(b) && b.result.content.startsWith("--- /dev/null"));
      const known = b.name !== "Write" || created ? !d.note : false;
      const prev = byPath.get(path);
      const add = (a: number | null, n: number) => (a === null || !known ? null : a + n);
      byPath.set(path, prev
        ? { ...prev, additions: add(prev.additions, d.add), deletions: add(prev.deletions, d.del) }
        : { path, shown: rel(path, root), oldShown: null, status: created ? "added" : "modified",
            additions: known ? d.add : null, deletions: known ? d.del : null });
    }
  }
  return [...byPath.values()];
}

/**
 * The checkpoint captured in front of the turn that began with the message at `askedAt`: a `turn`
 * checkpoint of this session's, taken after the turn before settled and no later than the message.
 * Realm captures it, then writes the message — so this is the clock's account of which checkpoint
 * fronted which turn, the same one the fork's transcript cut uses (SessionEventsStore.transcript).
 */
function frontingCheckpoint(checkpoints: readonly Checkpoint[], sessionId: string, after: number, askedAt: number): Checkpoint | null {
  let best: Checkpoint | null = null;
  for (const c of checkpoints) {
    if (c.kind !== "turn" || c.sessionId !== sessionId || c.createdAt <= after || c.createdAt > askedAt) continue;
    if (!best || c.createdAt > best.createdAt) best = c;
  }
  return best;
}

/** Every settled turn, as Undo needs to see it: which checkpoint fronted it, and whether it is known
 *  to have changed nothing — measured empty, or a turn that called no tool at all. */
export type TurnRecord = { key: string; checkpointId: string | null; quiet: boolean };

/**
 * Every settled turn's edits, by its run line's key — only for turns that changed something — and
 * every turn as Undo has to weigh it.
 *
 * Git's account wins wherever there is one. Where a checkpoint fronted the turn but its measurement
 * has not landed yet, the turn waits for it rather than showing the tool calls' numbers and then
 * swapping them under the reader; once a later message shows the measurement is never coming (a
 * session from before Realm measured turns), the tool calls are what is left to say.
 */
export function turnEdits(blocks: readonly Block[], opts: {
  changes: Readonly<Record<number, TurnChanges>> | undefined;
  checkpoints: readonly Checkpoint[] | undefined;
  sessionId: string; cwd: string | null; root: string | null;
}): { cards: Map<string, TurnEdits>; turns: TurnRecord[] } {
  const cards = new Map<string, TurnEdits>();
  const turns: TurnRecord[] = [];
  const root = (opts.root ?? opts.cwd ?? "").replace(/\/+$/, "");
  let lastUser = -1;
  blocks.forEach((b, i) => { if (b.kind === "user") lastUser = i; });
  let tools: Extract<Block, { kind: "tool" }>[] = [];
  let askedAt: number | null = null;
  let asked: string | null = null;
  let lastRun = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "tool") { tools.push(b); continue; }
    if (b.kind === "user") { if (askedAt === null) { askedAt = b.ts; asked = b.from || b.goal ? null : b.text; } continue; }
    if (b.kind !== "run") continue;
    const key = blockKey(b, i);
    const c = opts.changes?.[b.ts];
    const fronting = askedAt === null ? null : frontingCheckpoint(opts.checkpoints ?? [], opts.sessionId, lastRun, askedAt);
    // Measured, or still to be: the newest turn a checkpoint fronted, with no message after it yet.
    const pending = !c && fronting !== null && i > lastUser;
    if (c) {
      if (c.files.length > 0) cards.set(key, measured(c, asked));
    } else if (!pending && opts.cwd) {
      const files = fromTools(tools, opts.cwd, root);
      if (files.length > 0) cards.set(key, { files, totalFiles: files.length, source: "tools", checkpointId: fronting?.id ?? null, afterTree: null, root, asked });
    }
    turns.push({ key, checkpointId: c?.checkpointId ?? fronting?.id ?? null, quiet: c ? c.files.length === 0 : tools.length === 0 });
    tools = []; askedAt = null; asked = null; lastRun = b.ts;
  }
  return { cards, turns };
}

/** What Undo can honestly offer for one turn's card. */
export type UndoOffer =
  | { kind: "undo"; checkpointId: string }
  /** No checkpoint was taken in front of this turn, or it has since been pruned. Said, not hidden. */
  | { kind: "none"; why: string }
  /** It exists, but restoring it now would take later work with it — the card offers nothing. */
  | { kind: "later" };

/**
 * Whether restoring the turn's checkpoint would undo exactly this turn's edits — the only time the
 * button may say "Undo". Restoring puts the whole checkout back as the checkpoint found it, so every
 * checkpoint taken since must front a turn of this same session that is known to have changed
 * nothing. One from another session, a manual one, a restore's own undo point, a turn still being
 * measured — each is later work, and restoring past it would quietly take that too.
 */
export function undoOffer(edits: TurnEdits, turns: readonly TurnRecord[], checkpoints: readonly Checkpoint[] | undefined, sessionId: string): UndoOffer {
  const NONE = "Realm took no checkpoint before this turn, so it cannot put these files back. It takes one before each message in a git checkout.";
  if (!edits.checkpointId || !checkpoints) return { kind: "none", why: NONE };
  const at = checkpoints.findIndex((c) => c.id === edits.checkpointId);
  if (at < 0) return { kind: "none", why: "This turn's checkpoint is no longer kept — Realm keeps the newest fifty in each checkout." };
  const quiet = new Set(turns.filter((t) => t.quiet && t.checkpointId).map((t) => t.checkpointId!));
  for (const c of checkpoints.slice(0, at)) {
    if (c.kind !== "turn" || c.sessionId !== sessionId || !quiet.has(c.id)) return { kind: "later" };
  }
  return { kind: "undo", checkpointId: edits.checkpointId };
}

/** The card's head numbers: the sums, or null when any file's count is unknown — a total that left
 *  a file out would understate the turn without saying so. */
export function editTotals(files: readonly EditedFile[]): { additions: number; deletions: number } | null {
  let additions = 0, deletions = 0;
  for (const f of files) {
    if (f.additions === null || f.deletions === null) return null;
    additions += f.additions; deletions += f.deletions;
  }
  return { additions, deletions };
}
