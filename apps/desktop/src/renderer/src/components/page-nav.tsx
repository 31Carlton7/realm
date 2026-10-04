import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../state/store";

/**
 * A page's own navigation, in the sidebar's place.
 *
 * Settings, the Library, a profile's page and a space's page each carry a rail of their sections. Shown
 * over the panes, that rail stood beside the sidebar as a second column of navigation — two sidebars,
 * the one on the left about somewhere else. So while such a page is up, its rail takes the sidebar's
 * column instead, under a Back that puts the spaces back, the way a Mac app's settings or Codex's take
 * the whole sidebar over.
 *
 * The rail is MOVED, not copied: it is portalled into a slot the sidebar draws, so the page keeps
 * owning everything about it — which section is selected, what the settings search holds — and the
 * page underneath simply has no rail in it any more, which its stylesheet already lays out as a
 * centred column (`.page:has(.page-rail)` stops matching).
 *
 * Only a page shown over the panes moves its rail (`InPageOverlay`), and only while there is a sidebar
 * to move it into: collapsed, the column is off the window, and the rail stays in the page where it
 * can be reached. Outside the provider — a page or a sidebar rendered on its own, as the tests do —
 * nothing moves at all.
 */
type PageNavHost = {
  /** The page whose rail has the sidebar, by name, or null while the sidebar is its own. */
  claimed: string | null;
  /** Where that rail is drawn: the sidebar's slot, once it has mounted. */
  slot: HTMLElement | null;
  claim(label: string): () => void;
  setSlot(el: HTMLElement | null): void;
};

const HostContext = createContext<PageNavHost | null>(null);
const OverlayContext = createContext(false);

export function PageNavProvider({ children }: { children: ReactNode }) {
  const [claimed, setClaimed] = useState<string | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const claim = useCallback((label: string) => {
    setClaimed(label);
    return () => setClaimed((now) => (now === label ? null : now));
  }, []);
  const host = useMemo(() => ({ claimed, slot, claim, setSlot }), [claimed, slot, claim]);
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

/** Marks a subtree as the page shown over the panes — the one page whose rail may take the sidebar. */
export const InPageOverlay = OverlayContext.Provider;

/** For the sidebar: which page, if any, has its column, and the slot to draw that page's rail into. */
export function usePageNavHost(): PageNavHost | null {
  return useContext(HostContext);
}

/**
 * A page's rail. In the page while the page is a pane, or the sidebar is collapsed; in the sidebar's
 * column while the page is over the panes and the column is there to hold it. `label` names the page
 * for the column's Back. `inline={false}` is a rail that belongs in the sidebar only — the Library's
 * sections while a skill is read, which in the page would be a second rail beside the skill's own.
 */
export function PageRail({ label, inline = true, children }: { label: string; inline?: boolean; children: ReactNode }) {
  const host = useContext(HostContext);
  const inOverlay = useContext(OverlayContext);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const moves = host !== null && inOverlay && !collapsed;
  const claim = host?.claim;
  // A layout effect, so the column changes hands before the first paint: the rail is never seen in
  // the page for a frame and then jumping across.
  useLayoutEffect(() => (moves && claim ? claim(label) : undefined), [moves, claim, label]);
  if (!moves || !host) return inline ? <>{children}</> : null;
  return host.slot ? createPortal(children, host.slot) : null;
}
