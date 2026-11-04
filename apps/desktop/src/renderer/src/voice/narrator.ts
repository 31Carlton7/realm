import type { Block, PendingPermission, Transcript } from "../panes/session/transcript-model";
import { toolSummary } from "../panes/session/tool-summary";
import { ReplyReader, takeSentences } from "./reply-reader";

/** The least time between two spoken tool statuses: an agent running ten reads in a row is one
 *  "reading" and then quiet, not ten. */
export const TOOL_STATUS_GAP_MS = 6000;

const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

/** What a tool call sounds like, said in passing while the agent works. Null where saying it would
 *  only be noise (planning, asking — the question is read on its own). */
export function toolStatus(name: string, input: Record<string, unknown>): string | null {
  const str = (k: string) => (typeof input[k] === "string" && (input[k] as string).trim() ? (input[k] as string).trim() : null);
  const at = name.lastIndexOf("__");
  const bare = at < 0 ? name : name.slice(at + 2);
  switch (bare) {
    case "Bash": case "exec_command": {
      const what = str("description");
      return what ? `${what.replace(/\.$/, "")}.` : "Running a command.";
    }
    case "Read": return str("file_path") ? `Reading ${basename(str("file_path")!)}.` : "Reading a file.";
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": case "apply_patch": {
      const path = str("file_path") ?? str("notebook_path");
      return path ? `Editing ${basename(path)}.` : "Editing files.";
    }
    case "Grep": case "Glob": return "Searching the code.";
    case "WebFetch": case "WebSearch": case "web_search": return "Looking on the web.";
    case "Task": case "Agent": return "Handing part of this to a sub-agent.";
    case "TodoWrite": case "update_plan": case "AskUserQuestion": case "ui_ask": return null;
    default: {
      const subject = toolSummary(name, input);
      return subject && subject.length <= 60 && !subject.includes("\n") ? `Working on ${subject}.` : "Working.";
    }
  }
}

/** How a permission card is read: what is being asked, and how to answer it. */
export function permissionPrompt(p: PendingPermission, agentName: string): string {
  if (p.ask) return `${agentName} has a question for you in the chat.`;
  const what = p.title.replace(/`/g, "").replace(/\s+/g, " ").trim().replace(/[.:]$/, "");
  return `${agentName} asks to ${what.charAt(0).toLowerCase()}${what.slice(1)}. Say yes or no.`;
}

/**
 * Follows a session's transcript from the moment voice mode opened and says what is new: the reply as
 * it streams, a word about the tools it runs, each permission it asks for, and a failure. Everything
 * before `from` was there already and is not read.
 */
export class Narrator {
  private readers = new Map<string, ReplyReader>();
  private seenTools = new Set<string>();
  private readPermissions = new Set<string>();
  private seenErrors = new Set<number>();
  private lastToolAt = -Infinity;

  constructor(private from: number, private agentName: string) {}

  /** Start following from the end of `blocks`: what is already there is not read. */
  skipTo(from: number): void { this.from = from; }

  /** What to say now, in order. `silent` is whether nothing is being said: a tool status is only
   *  worth saying then, since behind other speech it would arrive stale. */
  next(t: Transcript, now: number, silent: boolean): string[] {
    const said: string[] = [];
    for (let i = this.from; i < t.blocks.length; i++) said.push(...this.block(t.blocks[i]!, i, now, silent && said.length === 0));
    for (const p of t.pendingPermissions) {
      if (this.readPermissions.has(p.requestId)) continue;
      this.readPermissions.add(p.requestId);
      said.push(permissionPrompt(p, this.agentName));
    }
    return said;
  }

  private block(b: Block, i: number, now: number, silent: boolean): string[] {
    if (b.kind === "assistant") {
      let reader = this.readers.get(b.messageId);
      if (!reader) { reader = new ReplyReader(); this.readers.set(b.messageId, reader); }
      return reader.feed(b.text, !b.streaming);
    }
    if (b.kind === "tool") {
      if (this.seenTools.has(b.toolUseId)) return [];
      this.seenTools.add(b.toolUseId);
      // A sub-agent's own calls are its business; its start was already said.
      if (b.parentToolUseId || b.result !== null || !silent || now - this.lastToolAt < TOOL_STATUS_GAP_MS) return [];
      const status = toolStatus(b.name, b.input);
      if (!status) return [];
      this.lastToolAt = now;
      return [status];
    }
    if (b.kind === "error") {
      if (this.seenErrors.has(i)) return [];
      this.seenErrors.add(i);
      const first = takeSentences(`${b.message} `).sentences[0] ?? b.message;
      return [`That failed: ${first.length > 160 ? `${first.slice(0, 157)}…` : first}`];
    }
    return [];
  }
}
