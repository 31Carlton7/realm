import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";

/**
 * The head of the Activity view: every session of the profile by when it last moved (Plan 27), opened
 * from a space's "Show all" or the title's "···". The switch stays lit while the view is up and a
 * click on it goes back to the space (`aria-pressed`, design.md: a lit control says the state and
 * undoes it). The view is remembered across launches (`sidebarLens`).
 */
export function SidebarLens() {
  const setSidebarLens = useApp((s) => s.setSidebarLens);
  const run = useApp((s) => s.run);
  return (
    <div className="sb-lens">
      <span className="sb-lens-title">Activity</span>
      <button type="button" className="icon-btn" aria-label="Activity" aria-pressed="true"
        title="Back to the space" onClick={() => run(() => setSidebarLens("spaces"))}>
        <Icon name="activity" size={14} />
      </button>
    </div>
  );
}
