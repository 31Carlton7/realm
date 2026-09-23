import type { SessionEvent } from "@realm/contracts";
import type { IconName } from "@realm/ui";
import { clip, toolIcon, toolSummary } from "../panes/session/tool-summary";

/** The last thing a session was seen doing: one line, the glyph that says what kind of doing, and —
 *  where the doing was a tool call — the tool's own name.
 *
 *  `tool` is carried beside `text` rather than parsed back out of it because the two answer different
 *  questions and only one of them is prose. The wall prints `text` ("pnpm vitest run"); the office
 *  animates on `tool` ("Bash"), which decides whether a character types or reads. Deriving either
 *  from the other means a renderer guessing at a string it did not build. */
export type SessionActivity = { text: string; icon: IconName; ts: number; tool: string | null };

/**
 * What one session event says the agent is DOING, or null when it says nothing about that.
 *
 * The wall needs a line per agent without opening a transcript. Every `session.event` is already
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
  const line = (icon: IconName, raw: string, tool: string | null = null): SessionActivity | null => {
    const text = clip(raw);
    return text ? { text, icon, ts: event.ts, tool } : null;
  };
  switch (event.type) {
    // The tool's own summary, which is the same string the transcript's row shows: a command, a
    // path, a query. Falls back to the tool's name, because a call with nothing quotable still
    // happened and "Bash" beats a blank line.
    case "tool_call": return line(toolIcon(event.payload.name), toolSummary(event.payload.name, event.payload.input) || event.payload.name, event.payload.name);
    // What it is blocked ON, which on this page is the most actionable fact there is.
    case "permission_request": return line("lock", event.payload.title || event.payload.toolName);
    case "assistant_text": return line("bot", event.payload.text);
    // The ask, so a tile says what its agent was set going on from the moment it was sent.
    case "user_message": return line("send", event.payload.text);
    case "error": return line("errorCircle", event.payload.message);
    default: return null;
  }
}
