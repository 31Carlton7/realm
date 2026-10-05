import { SidebarToggle } from "./SidebarToggle";
import { WindowNav } from "./WindowNav";

/**
 * The window's lead: back and forward beside the traffic lights, and — once the sidebar has folded
 * away — the toggle that brings it back. Codex's top-left: lights, ←, →, then the sidebar's glyph.
 *
 * Window chrome rather than part of any column. The rail under the lights is narrower than the lights
 * are, so the lights and this run across whatever the top row holds below them: the sidebar's head
 * while there is a sidebar, the first pane's bar or a page's bar while there is not, and each of those
 * makes room for it (`--lead-nav-end`, `--lead-end`). Fixed, and AFTER the panes in the document, which
 * is what keeps its buttons clickable: Electron lays the window's drag regions down in document order,
 * so a bar's drag region drawn later than these would take every press on them.
 *
 * The toggle joins only once the sidebar has finished leaving (`folded`): until then the sidebar's own
 * head row, which carries the same toggle, is still sliding out beside it.
 */
export function WindowLead({ folded }: { folded: boolean }) {
  return (
    <div className="window-lead">
      <WindowNav />
      {folded && <SidebarToggle />}
    </div>
  );
}
