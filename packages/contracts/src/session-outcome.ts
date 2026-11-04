import { z } from "zod";
import { SHELL_TOOL_NAMES } from "./session-facts";

/**
 * What a finished session produced, as its row on a teammate's computer ends: a pull request it
 * opened or merged, a release it published, or the error its last turn died on.
 *
 * Read only off what the session's own log recorded — a `gh` command that ran and the answer GitHub
 * printed back — never off its prose. A session that only SAID it opened a PR has no outcome, and a
 * row with no chip is the honest answer.
 */
export const SessionOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr"), number: z.number().int().positive(), url: z.string().nullable(), merged: z.boolean() }),
  z.object({ kind: z.literal("release"), tag: z.string() }),
  z.object({ kind: z.literal("failed"), reason: z.string() }),
]);
export type SessionOutcome = z.infer<typeof SessionOutcomeSchema>;

/** The slice of a session's log an outcome is read from, in the order it was written. */
export type OutcomeEvent =
  | { type: "tool_call"; payload: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { type: "tool_result"; payload: { toolUseId: string; content: string; isError: boolean } };

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/;

const bare = (name: string): string => { const at = name.lastIndexOf("__"); return at < 0 ? name : name.slice(at + 2); };

function commandOf(input: Record<string, unknown>): string {
  const c = input.command ?? input.cmd;
  return Array.isArray(c) ? c.join(" ") : typeof c === "string" ? c : "";
}

/** The outcome of the `gh` commands in a session's log: the release it published if it published
 *  one, else the last pull request it opened or merged, else null. */
export function sessionOutcome(events: readonly OutcomeEvent[]): SessionOutcome | null {
  const calls = new Map<string, string>();
  let release: SessionOutcome | null = null;
  let pr: SessionOutcome | null = null;
  for (const e of events) {
    if (e.type === "tool_call") {
      if (SHELL_TOOL_NAMES.has(bare(e.payload.name))) calls.set(e.payload.toolUseId, commandOf(e.payload.input));
      continue;
    }
    const command = calls.get(e.payload.toolUseId);
    if (command === undefined || e.payload.isError) continue;
    const out = e.payload.content;
    const tag = /\bgh release create\s+["']?([^\s"']+)/.exec(command);
    if (tag) { release = { kind: "release", tag: tag[1]! }; continue; }
    if (/\bgh pr create\b/.test(command)) {
      const url = PR_URL.exec(out);
      if (url) pr = { kind: "pr", number: Number(url[1]), url: url[0], merged: false };
      continue;
    }
    if (/\bgh pr merge\b/.test(command)) {
      const url = PR_URL.exec(command);
      const n = url?.[1] ?? /\bgh pr merge\s+#?(\d+)/.exec(command)?.[1] ?? /Merged pull request [\w./-]*#(\d+)/.exec(out)?.[1];
      if (n) pr = { kind: "pr", number: Number(n), url: url?.[0] ?? null, merged: true };
    }
  }
  return release ?? pr;
}

/** The first line of an error, short enough to sit under a row. */
export function failureReason(message: string): string {
  const line = message.trim().split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
