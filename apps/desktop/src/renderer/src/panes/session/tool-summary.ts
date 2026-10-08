import type { IconName } from "@realm/ui";
import { fileDiffsFor, isUnifiedDiff, parseUnifiedDiff } from "./rich/diff";

/**
 * The simulator's input tools, whose line is the agent's `intent` — what the step is for, which says
 * more than any of its coordinates. They reach the transcript fully prefixed
 * (`mcp__realm__realm-simulator__simulator_tap`) and a permission card bare, so both are matched.
 */
const SIMULATOR_INPUT = new Set(["simulator_tap", "simulator_double_tap", "simulator_long_press", "simulator_swipe", "simulator_type", "simulator_press"]);

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
    case "Task": case "Agent": return "agents";
    default: return "tool";
  }
}

/** An MCP call's two halves — the server that answered and its tool — or null for a call that did not
 *  go through MCP. `mcp__linear__save_issue` is Linear's `save_issue`; Realm's own servers arrive
 *  doubly prefixed (`mcp__realm__realm-browser__browser_open`), and claude.ai's connectors as
 *  `claude_ai_Linear`, so the server is named the way a person would name it. */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return null;
  const tool = parts[parts.length - 1]!;
  const raw = parts[parts.length - 2]!;
  if (parts[1] === "realm" || raw.startsWith("realm-")) return { server: "Realm", tool };
  const words = raw.replace(/^claude_ai_/, "").replace(/[_-]+/g, " ").trim();
  return { server: words ? words[0]!.toUpperCase() + words.slice(1) : raw, tool };
}

/** `save_issue` as a person would say it: "Save issue". */
const spoken = (tool: string): string => {
  const words = tool.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : tool;
};

/** The plain word for what a call DOES, the same for every agent: Claude's `Edit`, Codex's
 *  `apply_patch` and an ACP agent's edit all read "Edit", and `Bash` and `exec_command` both read
 *  "Run". The raw name stays in the row's tooltip and its accessible name; what the screen carries is
 *  the act, which does not change with the harness. */
const VERBS: Record<string, string> = {
  Bash: "Run", exec_command: "Run", shell: "Run", local_shell: "Run",
  Edit: "Edit", MultiEdit: "Edit", NotebookEdit: "Edit", apply_patch: "Edit",
  Write: "Write",
  Read: "Read", read_file: "Read", view_image: "Read",
  Grep: "Search", Glob: "Find files",
  WebFetch: "Fetch", WebSearch: "Search web", web_search: "Search web", webSearch: "Search web",
  TodoWrite: "Plan", update_plan: "Plan",
  Task: "Delegate", Agent: "Delegate",
};
/** ACP's kinds (map-acp.ts), for an agent whose call is named by a sentence rather than a tool. */
const ACP_VERBS: Record<string, string> = {
  read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search", execute: "Run", fetch: "Fetch", think: "Think",
};

export function toolVerb(name: string, toolKind?: string): string {
  const own = VERBS[name];
  if (own) return own;
  const mcp = mcpParts(name);
  if (mcp) return spoken(mcp.tool);
  if (toolKind && ACP_VERBS[toolKind]) return ACP_VERBS[toolKind]!;
  const at = name.lastIndexOf("__");
  return at < 0 ? name : name.slice(at + 2);
}

/** The few marks a vendor's MCP server can wear, keyed by how its server is named. Only vendors
 *  Realm draws a mark for; anything else takes the plug. */
const MCP_MARKS: Record<string, string> = {
  linear: "linear", notion: "notion", slack: "slack", github: "github", figma: "figma",
  sentry: "sentry", vercel: "vercel", atlassian: "jira", jira: "jira",
};

/** The glyph a call's row leads with at rest — what KIND of act it was, so thirty settled rows are
 *  found by shape rather than by a column of identical ticks. A read or an edit wears its file's own
 *  mark instead (`fileIconFor`, at the card), which says more than any generic page. */
export function toolGlyph(name: string, toolKind?: string): string {
  const mcp = mcpParts(name);
  if (mcp) {
    if (mcp.server === "Realm") return "plug";
    const key = mcp.server.toLowerCase().split(" ")[0]!;
    return MCP_MARKS[key] ?? "plug";
  }
  switch (VERBS[name] ?? (toolKind ? ACP_VERBS[toolKind] : undefined)) {
    case "Run": return "terminal";
    case "Search": case "Find files": return "search";
    case "Fetch": case "Search web": return "browser";
    case "Plan": return "checkCircle";
    case "Delegate": return "agents";
    case "Read": case "Edit": case "Write": case "Delete": case "Move": return "artifact";
    default: return "tool";
  }
}

/** The file a call READ, for its row's mark and object — the reading half of `editTarget`. */
export function readTarget(b: EditCall): string | null {
  if (b.name === "Read" || b.name === "read_file" || b.name === "view_image") {
    const p = b.input["file_path"] ?? b.input["path"];
    return typeof p === "string" && p !== "" ? p : null;
  }
  return b.toolKind === "read" && b.paths?.length ? b.paths[0]! : null;
}

/** An exit code the result STATES — Codex's `[exit N]` trailer, or Claude's `Exit code N` lead line —
 *  and the text without it. Null where the payload says nothing about one: a guessed code is a verdict
 *  nobody gave. */
export function statedExit(content: string): { code: number; rest: string } | null {
  const trailer = /\n?\[exit (\d+)\]\s*$/.exec(content);
  if (trailer) return { code: Number(trailer[1]), rest: content.slice(0, trailer.index) };
  const lead = /^\s*(?:Error: )?Exit code (\d+)\s*(?:\n|$)/.exec(content);
  if (lead) return { code: Number(lead[1]), rest: content.slice(lead[0].length) };
  return null;
}

/** The line a failed call is shown with under its row: the error's first line that says something. */
export function failureReason(content: string): string {
  const text = statedExit(content)?.rest ?? content;
  for (const line of text.split("\n")) { const t = line.trim(); if (t) return t; }
  return "";
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
