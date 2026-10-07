import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";

/**
 * The head of the sidebar's list: what the list is showing, and the switch to its other reading
 * (Plan 27). The owner, 10-04: "a smaller subsection title that says spaces, then all the way to the
 * right a button with an activity icon that shows the activity view."
 *
 * Two readings of the same sessions — under the space each works in, or by when each last moved — so
 * it is a lens rather than a place, and the one that is on is remembered across launches
 * (`sidebarLens`). It was a segmented control across the whole column: two equal tabs is a loud way
 * to offer a reading people rarely change, and a caption naming the one that is up says it quietly.
 *
 * The switch keeps its name and says whether it is on (`aria-pressed`, design.md: never both); the
 * caption beside it names what is showing, and the tooltip what a click will show.
 */
export function SidebarLens() {
  const lens = useApp((s) => s.sidebarLens);
  const setSidebarLens = useApp((s) => s.setSidebarLens);
  const run = useApp((s) => s.run);
  const activity = lens === "recent";
  return (
    <div className="sb-lens">
      <span className="sb-lens-title">{activity ? "Activity" : "Spaces"}</span>
      <button type="button" className="icon-btn" aria-label="Activity" aria-pressed={activity}
        title={activity ? "Show spaces" : "Show activity"} onClick={() => run(() => setSidebarLens(activity ? "spaces" : "recent"))}>
        <Icon name="activity" size={14} />
      </button>
    </div>
  );
}
