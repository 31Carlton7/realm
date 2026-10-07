import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";
import { sidebarHidden } from "../../state/selectors";
import { useChord } from "./use-sidebar-model";

/**
 * The control that collapses and restores the sidebar (⌘B), drawn as the window with its left panel
 * ruled off.
 *
 * In the top row in both states, the way Codex has it: at the end of the sidebar's own head row while
 * there is a sidebar, beside search and a new session; and in the window's lead (WindowLead) beside
 * the traffic lights and back and forward once it has folded away. A collapse control that disappears
 * on collapse is a trap, so there is never a state without one on screen.
 */
export function SidebarToggle() {
  const hidden = useApp(sidebarHidden);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const run = useApp((s) => s.run);
  const chord = useChord("sidebar.toggle");
  const label = `${hidden ? "Show" : "Hide"} sidebar${chord ? ` (${chord})` : ""}`;
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label}
      aria-expanded={!hidden} aria-controls="app-sidebar" onClick={() => run(() => toggleSidebar())}>
      <Icon name="panelLeft" size={14} />
    </button>
  );
}
