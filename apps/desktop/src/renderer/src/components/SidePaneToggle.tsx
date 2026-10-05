import { Icon } from "@realm/ui";
import { sidePaneLeaves, useApp } from "../state/store";

/**
 * Show and hide the side panes, from the window's top right — Codex's panel toggle, and the owner's
 * ask (10-04): "a button in the top right to show and hide the tabs instead of just making more
 * splits".
 *
 * A session's side pane is where everything it opens goes, as tabs: the terminal, documents, a
 * browser, a device — and where those are launched from, its "+" and a new tab's page, now that the
 * session's own bar carries none of them. Before this the only way to be rid of that column was to
 * close every tab in it. Put away, every tab stays open and as it was — a browser's page, a terminal's
 * scrollback, an agent still driving — and the session takes the width; brought back, it is where it
 * was. A tool opened by its key or from the palette brings it back too, since that is a person asking
 * to look (`openInSidePane`). With no side pane at all it opens one, on a new tab whose page lists
 * the session's tools, beside the session in focus.
 *
 * Window chrome, like the lead at the top left: fixed in the top row, after the panes in the document
 * so its button wins the bars' drag regions, and the bar under it makes room (`data-top-right`). Not
 * offered over a page, which has no side panes, nor where no session is on screen to have one.
 */
export function SidePaneToggle() {
  const sides = useApp((s) => (s.layout ? sidePaneLeaves(s.layout).length > 0 : false));
  const hidden = useApp((s) => s.sidePanesHidden);
  const owner = useApp((s) => s.peekOwner() !== null);
  const page = useApp((s) => s.pageOverlay !== null);
  const toggleSidePanes = useApp((s) => s.toggleSidePanes);
  const run = useApp((s) => s.run);
  if (page || (!sides && !owner)) return null;
  const shown = sides && !hidden;
  const label = shown ? "Hide side pane" : "Show side pane";
  return (
    <div className="window-trail">
      {/* `data-on` with a name that flips, the way the bar's other toggles that name their next action do. */}
      <button type="button" className="icon-btn" data-on={shown || undefined} aria-label={label}
        title={shown ? "Hide side pane — its tabs stay open" : sides ? "Show side pane" : "Show side pane — this session's tools and pages"}
        onClick={() => run(() => toggleSidePanes())}>
        <Icon name="panelRight" size={14} />
      </button>
    </div>
  );
}
