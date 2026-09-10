import { writtenPathOf } from "./documents";
import type { SessionEvent } from "./session-events";

/**
 * What a session did, counted off its own event log.
 *
 * This exists to be handed TO a summarizing model, not to be produced by one. A language model
 * reading a transcript will cheerfully report eight edited files when it was three, and a summary
 * that miscounts is worse than the derived line it replaces because it reads like it was checked.
 * So the numbers are folded here, from the events themselves, and the model is told to quote them.
 *
 * It folds EVENTS rather than the renderer's blocks deliberately: the server is where a summary is
 * generated, and the log is the same evidence the panes are built from without a round trip through
 * their shape. (The renderer keeps its own fold for the line it draws without a model —
 * `TranscriptSummary.recapSession`. The two answer the same question from the same facts; if they
 * ever disagree, this one is the one the model was shown.)
 */
export type SessionFacts = {
  /** The first thing the user asked, clipped to one line. "" when the log holds no user turn. */
  asked: string;
  /** How many times the user wrote (messages another session delivered are not the user's). */
  turns: number;
  /** Distinct paths successfully written, in first-touch order. */
  edited: string[];
  commands: number;
  reads: number;
  errors: number;
};

/** The harness-agnostic name: `mcp__realm-browser__browser_open` → `browser_open`. */
const bare = (name: string): string => { const at = name.lastIndexOf("__"); return at < 0 ? name : name.slice(at + 2); };

/** Tools that change a file, by every harness's name for them. */
export const EDIT_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "write_file", "edit_file", "create_file", "str_replace_editor"]);
/** Tools that run a command. */
export const SHELL_TOOL_NAMES = new Set(["Bash", "exec_command", "shell", "run_command", "run_terminal_cmd", "terminal", "execute", "bash"]);
/** Tools that only look. */
export const READ_TOOL_NAMES = new Set(["Read", "Grep", "Glob", "LS", "read_file", "list_directory", "search", "grep", "glob", "view", "cat", "find"]);

const firstLine = (text: string, max: number): string => {
  const line = text.trim().split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

export function sessionFacts(events: readonly SessionEvent[]): SessionFacts {
  let asked = ""; let turns = 0; let commands = 0; let reads = 0; let errors = 0;
  const edited: string[] = [];
  // A call is credited when its RESULT lands, so the two are matched by id rather than counted
  // apart: a tool_call with no result has not done anything — it is in flight, or the turn died
  // under it — and counting it would claim work the log cannot show.
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const e of events) {
    if (e.type === "user_message") {
      if (e.payload.from) continue; // a peer's words, not the user's
      turns += 1;
      if (!asked && e.payload.text.trim()) asked = firstLine(e.payload.text, 110);
    } else if (e.type === "tool_call") {
      calls.set(e.payload.toolUseId, { name: bare(e.payload.name), input: e.payload.input });
    } else if (e.type === "tool_result") {
      const call = calls.get(e.payload.toolUseId);
      if (!call) continue;
      calls.delete(e.payload.toolUseId);
      if (e.payload.isError) { errors += 1; continue; }
      if (EDIT_TOOL_NAMES.has(call.name)) {
        const p = writtenPathOf(call.input);
        if (p && !edited.includes(p)) edited.push(p);
      } else if (SHELL_TOOL_NAMES.has(call.name)) commands += 1;
      else if (READ_TOOL_NAMES.has(call.name)) reads += 1;
    } else if (e.type === "error") errors += 1;
  }
  return { asked, turns, edited, commands, reads, errors };
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** The facts as lines a model can quote. Empty when the session has done nothing countable, which is
 *  what tells the caller not to spend a call summarizing a greeting. */
export function factLines(f: SessionFacts): string {
  const out: string[] = [];
  if (f.turns > 0) out.push(`- the user wrote ${plural(f.turns, "time")}`);
  if (f.edited.length > 0) out.push(`- edited ${plural(f.edited.length, "file")}: ${f.edited.slice(0, 8).map(basename).join(", ")}${f.edited.length > 8 ? ", …" : ""}`);
  if (f.commands > 0) out.push(`- ran ${plural(f.commands, "command")}`);
  if (f.reads > 0) out.push(`- read ${plural(f.reads, "file")}`);
  if (f.errors > 0) out.push(`- hit ${plural(f.errors, "error")}`);
  return out.join("\n");
}

/** Nothing happened worth paying a model to describe: no work, and at most an opening line. */
export const nothingToSummarize = (f: SessionFacts): boolean =>
  f.edited.length === 0 && f.commands === 0 && f.reads === 0 && f.errors === 0 && f.turns <= 1;
