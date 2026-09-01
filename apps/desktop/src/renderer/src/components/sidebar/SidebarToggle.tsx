import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";

/**
 * The one control that collapses and restores the sidebar (⌘B).
 *
 * It is rendered in BOTH states, which is the whole design: open, it sits at the top-right of the
 * sidebar's own head row; collapsed, the same button reappears in the top rail just right of the
 * traffic lights. Same glyph, same accessible name pattern, same vertical band — so the button reads
 * as having MOVED rather than as two different affordances, and there is never a state with no way
 * back. A collapse control that disappears on collapse is a trap.
 */
export function SidebarToggle() {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const run = useApp((s) => s.run);
  return (
    <button className="sb-toggle" aria-label={collapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
      aria-expanded={!collapsed} onClick={() => run(() => toggleSidebar())}>
      <Icon name="sidebar" size={16} />
    </button>
  );
}
