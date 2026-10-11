import type { IconName } from "@realm/ui";
import { fileDiffsFor, isUnifiedDiff, parseUnifiedDiff } from "./rich/diff";
import { workflowMeta } from "./rich/workflow-meta";

/**
 * The simulator's input tools, whose line is the agent's `intent` — what the step is for, which says
 * more than any of its coordinates. They reach the transcript fully prefixed
 * (`mcp__realm__realm-simulator__simulator_tap`) and a permission card bare, so both are matched.
 */
const SIMULATOR_INPUT = new Set(["simulator_tap", "simulator_double_tap", "simulator_long_press", "simulator_swipe", "simulator_type", "simulator_press"]);

/**
 * What a `Workflow` call is called, wherever it is named: its row, its permission card, the
 * running-agents list with its watch and stop controls, the sub-agent panel. One function, so the
 * list can never offer to stop a run under a name the card beside it does not use.
 *
 * The name is the script's own, read out of its `meta` by workflow-meta.ts, in a call where that
 * script is what runs, which is one that carries neither a `scriptPath` nor a `name`. With either,
 * the harness runs the file or the saved workflow and not the script the model sent beside it. The
 * permission card is handed the script that runs, while the call's row keeps the model's. A name
 * read from `meta` there is one the card never showed, for a script that is not running. Such a
 * call is named by its file, which the harness takes before a name, then by the saved workflow,
 * then by the tool, and never "Sub-agent", which a workflow is not.
 *
 * The input's `description` and `title` are not read at all. The harness ignores both, so a name
 * taken from either is one nothing else on screen agrees with.
 */
export function workflowLabel(input: Record<string, unknown>): string {
  const field = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
  const path = field("scriptPath"), named = field("name");
  const script = input["script"];
  const meta = typeof script === "string" && path === "" && named === "" ? workflowMeta(script) : null;
  if (meta) return meta.name;
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || named || "Workflow";
}

/** One-line summary of a tool call's input, per well-known tool; else the first string field. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const at = name.lastIndexOf("__");
  if (SIMULATOR_INPUT.has(at < 0 ? name : name.slice(at + 2))) return str("intent") ?? "";
  switch (name) {
    case "Bash": return str("command") ?? "";
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return str("file_path") ?? str("notebook_path") ?? "";
    case "Glob": case "Grep": return str("pattern") ?? "";
    case "WebFetch": return str("url") ?? "";
    case "WebSearch": return str("query") ?? "";
    case "Task": case "Agent": return str("description") ?? str("prompt") ?? "";
    case "Workflow": return workflowLabel(input);
    case "TodoWrite": return "update todos";
    case "exec_command": return str("command") ?? "";
    case "apply_patch": {
      const changes = input["changes"];
      const first = Array.isArray(changes) ? changes[0] : null;
      const path = first && typeof first === "object" ? (first as Record<string, unknown>)["path"] : null;
      return typeof path === "string" ? path : "";
    }
    default: { for (const v of Object.values(input)) if (typeof v === "string" && v.trim()) return v; return ""; }
  }
}

export function toolIcon(name: string): IconName {
  switch (name) {
    case "Bash": case "exec_command": return "terminal";
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": case "apply_patch": return "artifact";
    case "Glob": case "Grep": return "search";
    case "WebFetch": case "WebSearch": return "browser";
    case "Task": case "Agent": return "bot";
    default: return "tool";
  }
}

export type EditStat = { add: number; del: number };

/** Measured add/del line counts for a file-editing tool (Plan 9 W2: ThinkingState's `+74 −41`).
 *
 *  Derived from the SAME diff the card below the row draws (`fileDiffsFor`), so the two can never
 *  disagree — and so the counts mean what a diff means. Counting every line of an Edit's two
 *  fragments, which is what this did before there was a diff to ask, called a one-line change
 *  inside twenty lines of context "+20 −20".
 *
 *  Null where the payload does not support a diff at all (Read, Bash, a permission preview carrying
 *  no strings, an `apply_patch` envelope with no patch body): no counts is honest, invented counts
 *  are not. */
export function editStat(name: string, input: Record<string, unknown>): EditStat | null {
  const files = fileDiffsFor(name, input);
  if (!files) return null;
  let add = 0, del = 0;
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) { if (l.kind === "add") add++; else if (l.kind === "del") del++; }
  return add === 0 && del === 0 ? null : { add, del };
}

/** ACP's kinds that name a file the call changes. */
const ACP_FILE_KINDS = new Set(["edit", "delete", "move"]);

/** A call as the row knows it — enough to say which file it edited. */
type EditCall = { name: string; input: Record<string, unknown>; toolKind?: string; paths?: readonly string[] };

/**
 * The file an editing call changed, for its row — Claude's `file_path`, Codex's first patched file,
 * an ACP edit's first location — with how many more the same call touched (one patch can carry
 * several). Null for a call that edits no file, which keeps the row it always had.
 */
export function editTarget(b: EditCall): { path: string; more: number } | null {
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  switch (b.name) {
    case "Edit": case "MultiEdit": case "Write": { const p = str(b.input["file_path"]); return p ? { path: p, more: 0 } : null; }
    case "NotebookEdit": { const p = str(b.input["notebook_path"]); return p ? { path: p, more: 0 } : null; }
    case "apply_patch": {
      const changes = b.input["changes"];
      const paths = Array.isArray(changes) ? changes.map((c) => str((c as Record<string, unknown> | null)?.["path"])).filter((p): p is string => p !== null) : [];
      return paths.length ? { path: paths[0]!, more: paths.length - 1 } : null;
    }
  }
  if (b.toolKind && ACP_FILE_KINDS.has(b.toolKind) && b.paths?.length) return { path: b.paths[0]!, more: b.paths.length - 1 };
  return null;
}

/** An ACP edit's counts, read off the unified diff its result carries (map-acp.ts). Null where the
 *  result is no diff — a call that has not finished, or one whose agent sent no diff content. */
export function resultEditStat(b: EditCall & { result: { content: string; isError: boolean } | null }): EditStat | null {
  if (!b.toolKind || !ACP_FILE_KINDS.has(b.toolKind) || !b.result || b.result.isError || !isUnifiedDiff(b.result.content)) return null;
  let add = 0, del = 0;
  for (const f of parseUnifiedDiff(b.result.content)) { add += f.add; del += f.del; }
  return add === 0 && del === 0 ? null : { add, del };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export const clip = (s: string, n = 90): string => { const o = oneLine(s); return o.length > n ? `${o.slice(0, n - 1)}…` : o; };
export const prettyJson = (v: unknown): string => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
