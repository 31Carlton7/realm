import type { SessionEvent } from "@realm/contracts";
import type { IconName } from "@realm/ui";
import { clip, toolIcon, toolSummary } from "../panes/session/tool-summary";

/** The last thing a session was seen doing: one line, and the glyph that says what kind of doing. */
export type SessionActivity = { text: string; icon: IconName; ts: number };

/**
 * What one session event says the agent is DOING, or null when it says nothing about that.
 *
 * A sub-agent's card needs a line per agent without opening a transcript. Every `session.event` is already
 * broadcast to every window — the store drops the ones whose session nobody has opened — so the
 * line costs one fold over a stream that is arriving anyway: no fetch, no subscription, and nothing
 * held per session but the newest answer.
 *
 * Null rather than a placeholder is the whole discipline here. A `usage` reading, a rate-limit
 * window and a settle carry no account of the work, so they leave the last real line standing;
 * inventing "Working…" for them would replace something true with something that is true of every
 * agent at all times.
 *
 * `assistant_delta` is deliberately not a case. It is the same sentence arriving a token at a time,
 * and folding it would write to the store once per token per session — the exact cost
 * `flushSessionDeltas` exists to avoid. The persisted `assistant_text` says it once, at the end.
 */
export function activityOf(event: SessionEvent): SessionActivity | null {
  const line = (icon: IconName, raw: string): SessionActivity | null => {
    const text = clip(raw);
    return text ? { text, icon, ts: event.ts } : null;
  };
  switch (event.type) {
    // The tool's own summary, which is the same string the transcript's row shows: a command, a
    // path, a query. Falls back to the tool's name, because a call with nothing quotable still
    // happened and "Bash" beats a blank line.
    case "tool_call": return line(toolIcon(event.payload.name), toolSummary(event.payload.name, event.payload.input) || event.payload.name);
    // What it is blocked ON, which is the most actionable fact a line can carry.
    case "permission_request": return line("lock", event.payload.title || event.payload.toolName);
    case "assistant_text": return line("bot", event.payload.text);
    // The ask, so a line says what its agent was set going on from the moment it was sent.
    case "user_message": return line("send", event.payload.text);
    case "error": return line("errorCircle", event.payload.message);
    default: return null;
  }
}
