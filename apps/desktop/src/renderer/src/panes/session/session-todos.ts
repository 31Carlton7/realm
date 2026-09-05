import { parseTodos, type Todo } from "./rich/tool-view";
import type { Block } from "./transcript-model";

/**
 * The session's plan as it stands now: its most recent TodoWrite, because every TodoWrite restates
 * the whole list rather than amending the last one.
 *
 * Derived from the transcript rather than held beside it. The transcript is folded from the
 * session's persisted events, so this survives a re-render and a reload with no state of its own to
 * keep in step — a store slice would have to be rebuilt from the same events anyway, and could
 * disagree with the cards the reader is scrolling through.
 *
 * A sub-agent's list is not the session's. A Task's child restates ITS plan through the same tool,
 * and pinning that above the prompter would show the reader work they did not ask for in place of
 * the work they are watching.
 */
export function latestTodos(blocks: readonly Block[]): Todo[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind !== "tool" || b.name !== "TodoWrite" || b.parentToolUseId) continue;
    // First match wins, even when it does not parse: an agent drops its plan by writing an empty
    // list, and reaching further back for one that does parse would put the abandoned plan back.
    return parseTodos(b.input) ?? [];
  }
  return [];
}
