import { blockKey, type Block } from "./transcript-model";
import { toolSummary } from "./tool-summary";

export type ToolBlock = Extract<Block, { kind: "tool" }>;

/** §2.8: "the agent's work is a quiet ledger" — a run of consecutive tool calls collapses to one
 *  summary line ("18 tools · 5 files · 2 commands · 6m 12s") that expands into its steps.
 *
 *  Runs shorter than this stay inline. §5 says "group consecutive tools" without naming a floor;
 *  two rows behind a summary line costs a click and saves nothing, so the floor is three. */
export const GROUP_MIN = 3;

/** Tools whose summary is the path they touched, and tools that run a command. Kept here rather than
 *  imported from tool-summary's switch so that widening one does not silently widen the other. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
const COMMAND_TOOLS = new Set(["Bash", "exec_command"]);

export type TranscriptItem =
  | { kind: "block"; key: string; block: Block }
  | { kind: "group"; key: string; steps: { key: string; block: ToolBlock }[] };

/** Blocks in render order, with runs of GROUP_MIN+ consecutive tool calls folded into one group.
 *  Every item — grouped or not — keeps the key it would have had ungrouped, so a run crossing the
 *  threshold neither remounts its cards nor re-triggers their enter animation. */
export function groupTranscript(blocks: readonly Block[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (b.kind !== "tool") { out.push({ kind: "block", key: blockKey(b, i), block: b }); i++; continue; }
    let end = i;
    while (end < blocks.length && blocks[end]!.kind === "tool") end++;
    const steps = blocks.slice(i, end).map((s, k) => ({ key: blockKey(s, i + k), block: s as ToolBlock }));
    // Keyed on the run's first tool: a run only ever grows at its tail, so the group keeps its
    // identity — and the user's expand/collapse choice — as more tools land in it.
    if (steps.length >= GROUP_MIN) out.push({ kind: "group", key: `group:${steps[0]!.key}`, steps });
    else for (const s of steps) out.push({ kind: "block", key: s.key, block: s.block });
    i = end;
  }
  return out;
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

/** "18 tools · 5 files · 2 commands · 6m 12s" — zero-valued parts drop out entirely. */
export function formatToolRun(s: ToolRunSummary): string {
  const parts = [plural(s.tools, "tool")];
  if (s.files > 0) parts.push(plural(s.files, "file"));
  if (s.commands > 0) parts.push(plural(s.commands, "command"));
  const secs = Math.round(s.durationMs / 1000);
  if (secs > 0) parts.push(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
  return parts.join(" · ");
}
