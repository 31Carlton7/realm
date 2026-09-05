import { Icon } from "@realm/ui";
import { useState } from "react";
import { TodoHeadline, TodoItems, TodoTrack } from "./rich/ToolViews";
import type { Todo } from "./rich/tool-view";

/**
 * The session's plan, attached to the top of the prompter.
 *
 * A plan is standing context, not a moment in the log. Drawn only inside its TodoWrite card it
 * scrolls away the moment the agent does anything else, so the reader who wants to know what is
 * left has to go hunting back through the run for it. The card keeps its copy — that is what the
 * plan was then — and this is what it is now.
 *
 * The card is not touched. It is closed by default and each one holds the list as written at that
 * point, so there is no second copy on screen unless a reader opens one; and making the newest card
 * draw itself differently from every older one would be a rule nobody could learn from watching.
 */
export function TodoStrip({ todos }: { todos: readonly Todo[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const allDone = todos.length > 0 && done === todos.length;
  // Same shape as the run group's header (ToolCard.tsx): a derived default a click can override.
  // The override sticks once made, including across a later plan — an agent updating its list must
  // not reopen a strip the reader deliberately shut and shove the prompter down under their hands.
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? !allDone;
  // Nothing to pin, so nothing to take room: no header, no rule above the card, no gap.
  if (todos.length === 0) return null;
  return (
    <div className="composer-todos" data-open={open || undefined}>
      <button type="button" className="composer-todos-head" aria-expanded={open}
        aria-label={allDone ? "Plan complete" : "Plan"} onClick={() => setManual(!open)}>
        <TodoHeadline todos={todos} />
        <Icon name="chevronRight" size={12} className="composer-todos-caret" />
      </button>
      {/* Outside the collapse: finished or shut, the filled bar is what says how the run went, and
          it is the only part of this legible without reading. */}
      <TodoTrack todos={todos} />
      <div className="composer-todos-wrap">
        <div className="composer-todos-clip" inert={!open || undefined}>
          <TodoItems todos={todos} />
        </div>
      </div>
    </div>
  );
}
