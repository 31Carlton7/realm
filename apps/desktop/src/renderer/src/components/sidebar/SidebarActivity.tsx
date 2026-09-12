import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";

/**
 * The lens on the sidebar's body: the space's items, or every chat you have, by day.
 *
 * This lens used to hold the MCP gateway's call log. It now holds the chats, because that is the
 * question this control is actually reached for: the space list answers "what is open here", and
 * nothing answered "what have I been working on" without leaving the sidebar. The gateway log was
 * always the glance rather than the record — the record is the sheet, reached from ⌘K and from a
 * space's Connections tab, and both of those are untouched.
 *
 * A lit button says which lens is on and flips it back, the destination rows' rule — `aria-pressed`
 * rather than a name that changes, because "Activity" is what this shows either way.
 */
export function SidebarActivity() {
  const on = useApp((s) => s.sidebarView === "activity");
  const setSidebarView = useApp((s) => s.setSidebarView);
  return (
    <button className="sb-toggle" aria-label="Activity" aria-pressed={on}
      title="Every chat, across all spaces, by day" onClick={() => setSidebarView(on ? "space" : "activity")}>
      <Icon name="activity" size={14} />
    </button>
  );
}
