import { blockKey, type Block } from "./transcript-model";
import { toolSummary } from "./tool-summary";

export type ToolBlock = Extract<Block, { kind: "tool" }>;

/** §2.8: "the agent's work is a quiet ledger" — a run of consecutive tool calls collapses to one
 *  summary line ("18 tools · 5 files · 2 commands · 6m 12s") that expands into its steps.
 *
 *  Runs shorter than this stay inline. §5 says "group consecutive tools" without naming a floor;
 *  two consecutive calls already read as a run, so only a lone tool call stays inline. */
export const GROUP_MIN = 2;

/** Tools whose summary is the path they touched, and tools that run a command. Kept here rather than
 *  imported from tool-summary's switch so that widening one does not silently widen the other. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
const COMMAND_TOOLS = new Set(["Bash", "exec_command"]);

/** A tool call together with the calls a sub-agent made underneath it.
 *
 *  A sub-agent's calls arrive INTERLEAVED with the parent's own — the harness runs them
 *  concurrently and the transcript is one stream in arrival order — so nothing about position
 *  separates them. The only thing that does is `parentToolUseId`, which is why this is a tree built
 *  from ids rather than another fold over runs. */
export type ToolNode = { key: string; block: ToolBlock; nested: ToolNode[] };

/** A `ToolNode` marked with §6's enter flag, which only the renderer can decide. */
export type ToolStep = { key: string; block: ToolBlock; enter: boolean; nested: readonly ToolStep[] };

/** One array, shared by every childless node. `withEnter` runs on each render, and handing each of
 *  a 300-call transcript its own fresh `[]` would fail ToolCard's memo on all of them. */
const NO_STEPS: readonly ToolStep[] = [];

export type TranscriptItem =
  /** `nested` is empty for everything but a tool call whose sub-agent did some work of its own. */
  | { kind: "block"; key: string; block: Block; nested: ToolNode[] }
  | { kind: "group"; key: string; steps: ToolNode[] };

const NO_NESTED: ToolNode[] = [];

/** Blocks in render order: sub-agent calls hung off the call that spawned them, and runs of
 *  GROUP_MIN+ consecutive tool calls among what is left folded into one group.
 *
 *  Every item — grouped, nested or neither — keeps the key it would have had ungrouped, so a run
 *  crossing the threshold neither remounts its cards nor re-triggers their enter animation.
 *
 *  Lifting a sub-agent's calls out of the top level closes the gaps they left, so a parent's own
 *  calls that were only separated by its child's now group as the one run they always were. */
export function groupTranscript(blocks: readonly Block[]): TranscriptItem[] {
  const nodes = new Map<string, ToolNode>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "tool") nodes.set(b.toolUseId, { key: blockKey(b, i), block: b, nested: [] });
  }

  const top: { key: string; block: Block; nested: ToolNode[] }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind !== "tool") { top.push({ key: blockKey(b, i), block: b, nested: NO_NESTED }); continue; }
    const node = nodes.get(b.toolUseId)!;
    const parent = b.parentToolUseId === undefined ? undefined : nodes.get(b.parentToolUseId);
    // A parent this transcript does not contain leaves the call where it is. An id Realm cannot
    // resolve is still work the agent did, and hiding it would lose the call rather than nest it.
    if (parent && parent !== node) parent.nested.push(node); else top.push(node);
  }

  const out: TranscriptItem[] = [];
  let i = 0;
  while (i < top.length) {
    const e = top[i]!;
    if (e.block.kind !== "tool") { out.push({ kind: "block", key: e.key, block: e.block, nested: NO_NESTED }); i++; continue; }
    const steps: ToolNode[] = [];
    while (i < top.length) {
      const s = top[i]!;
      if (s.block.kind !== "tool") break;
      steps.push({ key: s.key, block: s.block, nested: s.nested });
      i++;
    }
    // Keyed on the run's first tool: a run only ever grows at its tail, so the group keeps its
    // identity — and the user's expand/collapse choice — as more tools land in it.
    if (steps.length >= GROUP_MIN) out.push({ kind: "group", key: `group:${steps[0]!.key}`, steps });
    else for (const s of steps) out.push({ kind: "block", key: s.key, block: s.block, nested: s.nested });
  }
  return out;
}

/** Marks a tool tree with the enter flags the transcript's tracker just decided (transcript-enter).
 *  Recursive because a sub-agent's cards animate in on arrival exactly as the agent's own do. */
export function withEnter(nodes: readonly ToolNode[], isEntering: (key: string) => boolean): readonly ToolStep[] {
  if (nodes.length === 0) return NO_STEPS;
  return nodes.map((n) => ({ key: n.key, block: n.block, enter: isEntering(n.key), nested: withEnter(n.nested, isEntering) }));
}

export type ToolRunSummary = { tools: number; files: number; commands: number; durationMs: number };

/** Counts behind the collapsed line. `files` is distinct paths — an agent reading the same file four
 *  times edited one file, and saying "4 files" would be a lie. */
export function summarizeToolRun(blocks: readonly ToolBlock[]): ToolRunSummary {
  const files = new Set<string>();
  let commands = 0;
  for (const b of blocks) {
    if (FILE_TOOLS.has(b.name)) { const p = toolSummary(b.name, b.input); if (p) files.add(p); }
    if (COMMAND_TOOLS.has(b.name)) commands++;
  }
  const first = blocks[0], last = blocks[blocks.length - 1];
  return { tools: blocks.length, files: files.size, commands, durationMs: first && last ? Math.max(0, last.ts - first.ts) : 0 };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The `Worked for <this>` half of the collapsed ledger row (Ara refresh §4): "<1s", "42s",
 *  "6m 12s", "1h 4m". A settled sub-second run says "<1s" rather than the lie "0s". Seconds drop
 *  past the hour: at that length they are noise, and "124m 3s" is arithmetic the reader should not
 *  have to do. Shared with the per-run line the transcript settles on (Transcript's `run` block). */
export function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 1) return "<1s";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor(secs / 60) % 60}m`;
}

/** "18 tools · 5 files · 2 commands · 6m 12s" — zero-valued parts drop out entirely. */
export function formatToolRun(s: ToolRunSummary): string {
  const parts = [plural(s.tools, "tool")];
  if (s.files > 0) parts.push(plural(s.files, "file"));
  if (s.commands > 0) parts.push(plural(s.commands, "command"));
  const secs = Math.round(s.durationMs / 1000);
  if (secs > 0) parts.push(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
  return parts.join(" · ");
}
