import { Icon } from "@realm/ui";
import { useApp } from "../state/store";
import { panelPlace } from "../state/view-room";

/**
 * Show and hide the side panel, from the window's top right — Codex's panel toggle, and the owner's
 * ask (10-04): "a button in the top right to show and hide the tabs instead of just making more
 * splits".
 *
 * The panel is where everything the sessions on screen open goes, as tabs: a terminal, documents, a
 * browser, a device — and where those are launched from, its "+" and a new tab's page, now that the
 * session's own bar carries none of them. Put away, every tab stays open and as it was — a browser's
 * page, a terminal's scrollback, an agent still driving — and the main panes take the width; brought
 * back, it is where it was. A tool opened by its key or from the palette brings it back too, since that
 * is a person asking to look (`openInSidePane`). With nothing in it, it opens the panel on a new tab
 * whose page lists the session's tools.
 *
 * Where there is no room beside the panes for the panel at its floor, it has stepped aside (the panel
 * gives way before any pane does), and the toggle shows it in the panes' place — the full view ⌥⌘B
 * opens — rather than squeezing them; lit there, it puts the panel away and gives the panes back.
 *
 * Window chrome, like the lead at the top left: fixed in the top row, after the panes in the document
 * so its button wins the bars' drag regions, and the bar under it makes room (`data-top-right`). Not
 * offered over a page, which has no panel, nor where no session is on screen to have one.
 */
export function SidePaneToggle() {
  const place = useApp((s) => panelPlace(s).kind);
  const owner = useApp((s) => s.peekOwner() !== null);
  const page = useApp((s) => s.pageOverlay !== null);
  const toggleSidePanes = useApp((s) => s.toggleSidePanes);
  const run = useApp((s) => s.run);
  if (page || (place === "none" && !owner)) return null;
  const shown = place === "beside" || place === "full";
  const label = shown ? "Hide side panel" : "Show side panel";
  const title = shown ? "Hide side panel — its tabs stay open"
    : place === "aside" ? "Show side panel — no room beside these panes, so it takes their place"
    : place === "away" ? "Show side panel"
    : "Show side panel — this session's tools and pages";
  return (
    <div className="window-trail">
      {/* `data-on` with a name that flips, the way the bar's other toggles that name their next action do. */}
      <button type="button" className="icon-btn" data-on={shown || undefined} aria-label={label} title={title}
        onClick={() => run(() => toggleSidePanes())}>
        <Icon name="panelRight" size={14} />
      </button>
    </div>
  );
}
