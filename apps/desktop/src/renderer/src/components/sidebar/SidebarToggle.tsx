import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";

/**
 * The one control that collapses and restores the sidebar (⌘B).
 *
 * It lives in the rail, which stays on screen when the sidebar folds away, so it is in the same place
 * in both states and there is never a state with no way back. A collapse control that disappears on
 * collapse is a trap.
 */
export function SidebarToggle() {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const run = useApp((s) => s.run);
  return (
    <button type="button" className="rail-btn" aria-label={collapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
      aria-expanded={!collapsed} aria-controls="app-sidebar" onClick={() => run(() => toggleSidebar())}>
      <Icon name="sidebar" size={18} />
    </button>
  );
}
