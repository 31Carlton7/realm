import type { SessionStatus } from "@realm/contracts";
import { summarize, writtenPath } from "./session-summary";
import type { Block } from "./transcript-model";

/**
 * What a session produced, in one line, at the end of its transcript.
 *
 * Counts only. It sits a few pixels below a transcript you can still scroll, so anything longer
 * would be re-reading the session at you — and it is derived from the same pure fold the summary
 * panel uses, so the two can never disagree.
 *
 * Null when the session did nothing worth counting.
 */
export function summaryLine(blocks: readonly Block[]): string | null {
  const { outputs, uploads, plans } = summarize(blocks);
  const files = outputs.filter((o) => o.kind === "file").length;
  const links = outputs.length - files;
  const parts = [
    files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : null,
    links > 0 ? `${links} ${links === 1 ? "link" : "links"}` : null,
    plans.length > 0 ? `${plans.length} ${plans.length === 1 ? "plan" : "plans"}` : null,
    uploads.length > 0 ? `${uploads.length} attached` : null,
  ].filter(Boolean);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The harness-agnostic name: `mcp__realm-browser__browser_open` → `browser_open`. */
const bare = (name: string): string => { const at = name.lastIndexOf("__"); return at < 0 ? name : name.slice(at + 2); };
/** Tools that change files, by every harness's name for them. Mirrors `session-summary`'s set. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "write_file", "edit_file", "create_file"]);
/** Tools that run a command. */
const SHELL_TOOLS = new Set(["Bash", "exec_command", "shell", "run_command", "run_terminal_cmd", "terminal", "execute", "bash"]);
/** Tools that only look. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "read_file", "list_directory", "search", "grep", "glob", "view", "cat", "find"]);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const firstLine = (text: string, max: number): string => {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** What a session DID, folded from its blocks. Exported for the test; the component reads `text`. */
export type SessionRecap = {
  /** The first thing the user asked, clipped. "" when the transcript holds no user turn. */
  asked: string;
  /** How many times the user wrote. */
  turns: number;
  /** Distinct paths successfully edited, in first-touch order. */
  edited: string[];
  commands: number;
  reads: number;
  errors: number;
};

export function recapSession(blocks: readonly Block[]): SessionRecap {
  let asked = ""; let turns = 0; let commands = 0; let reads = 0; let errors = 0;
  const edited: string[] = [];
  for (const b of blocks) {
    if (b.kind === "user" && !b.from) {
      turns += 1;
      if (!asked && b.text.trim()) asked = firstLine(b.text, 110);
    } else if (b.kind === "tool") {
      // A call with no result yet has not DONE anything: it is in flight, or the turn died under
      // it. Counting it as "ran" would claim work the transcript cannot show.
      if (!b.result) continue;
      const name = bare(b.name);
      if (b.result.isError) errors += 1;
      if (EDIT_TOOLS.has(name)) {
        if (!b.result.isError) {
          const p = writtenPath(name, b.input);
          if (p && !edited.includes(p)) edited.push(p);
        }
      } else if (SHELL_TOOLS.has(name)) commands += 1;
      else if (READ_TOOLS.has(name)) reads += 1;
    } else if (b.kind === "error") errors += 1;
  }
  return { asked, turns, edited, commands, reads, errors };
}

/**
 * The closing line in prose: what was asked, what the agent did about it, what came out.
 *
 * It used to say "This session produced 1 file · 4 attached", which is true and useless — it names
 * the residue and not the work. A reader coming back to a session wants the ask and the shape of the
 * answer: which files changed, whether anything ran, whether anything failed. All of it is DERIVED
 * from the transcript, never generated; the line is a fold, so it is free and it cannot lie.
 *
 * Null when there is nothing to say: no ask and no work. A line under every "hello" would be noise
 * attached to the ordinary case, and that gate is why this can be shown by default at all.
 */
export function summaryText(blocks: readonly Block[]): string | null {
  const r = recapSession(blocks);
  const produced = summaryLine(blocks);
  const did: string[] = [];
  if (r.edited.length > 0) {
    const names = r.edited.slice(0, 3).map(basename).join(", ");
    const rest = r.edited.length - 3;
    did.push(`edited ${plural(r.edited.length, "file")} (${names}${rest > 0 ? `, +${rest}` : ""})`);
  }
  if (r.commands > 0) did.push(`ran ${plural(r.commands, "command")}`);
  if (r.reads > 0) did.push(`read ${plural(r.reads, "file")}`);
  if (did.length === 0 && !produced) return null;
  const sentences: string[] = [];
  if (r.asked) sentences.push(`You asked: “${r.asked}”`);
  if (did.length > 0) {
    const list = did.length === 1 ? did[0]! : `${did.slice(0, -1).join(", ")} and ${did.at(-1)}`;
    const over = r.turns > 1 ? `Over ${plural(r.turns, "turn")} the agent ${list}` : `The agent ${list}`;
    sentences.push(r.errors > 0 ? `${over}, with ${plural(r.errors, "error")} along the way` : over);
  }
  if (produced) sentences.push(`It produced ${produced}`);
  return sentences.join(". ") + ".";
}

/**
 * The quiet closing line of a session.
 *
 * It exists because a transcript gives you no way to see what it amounted to without scrolling it.
 * What is gated is what always was:
 *
 *   - **Settled only.** Mid-turn the counts are still moving, and a total that climbs while you read
 *     it is not a summary of anything. It appears the moment the turn ends.
 *   - **Something to say.** See `summaryText`.
 */
export function TranscriptSummary({ blocks, status, written = null }: {
  blocks: readonly Block[];
  status: SessionStatus;
  /** The model's account of this session, when one has been written (`transcript.summary`). It wins
   *  over the derived line because it answers the question the line only gestures at — a reader
   *  coming back wants what happened, not what was counted. Null is the ordinary case and always
   *  will be: a session that has not settled yet, a machine with no model to ask, a call still in
   *  flight. The fold below is what shows then, exactly as it did before any of this existed. */
  written?: string | null;
}) {
  if (status === "running" || status === "waiting_permission") return null;
  const what = written?.trim() || summaryText(blocks);
  if (!what) return null;
  return (
    // Keyed on the text so the entrance REPLAYS when the summary changes. A CSS animation fires when
    // an element is inserted, and this element outlives every turn — without the key the first
    // summary would fade in and every later one would snap into place under the reader, which is
    // the case that actually matters now that a written summary lands after the derived one.
    <p key={what} className="msg-transcript-summary" role="note">
      {what}
    </p>
  );
}
