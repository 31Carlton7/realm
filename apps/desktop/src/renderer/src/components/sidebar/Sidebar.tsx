import { Icon } from "@realm/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useApp, useProfileSpaces } from "../../state/store";
import { usePageNavHost } from "../page-nav";
import { useDissolve } from "../ScrollFades";
import { NeedsYou } from "./NeedsYou";
import { PinnedList } from "./PinnedList";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { RecentList } from "./RecentList";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarLens } from "./SidebarLens";
import { SidebarResizer } from "./SidebarResizer";
import { SpaceSections } from "./SpaceSections";
import { pinnedItems } from "./model";
import { useAllItemsFresh, useOpenAnywhere, useProfileRows, useSidebarState } from "./use-sidebar-model";

/**
 * The sidebar (Plan 27): get me to my work, and tell me what needs me.
 *
 * Six things, in this order, and nothing the window already shows: its toggle, search and a new
 * session in the head row; the profile under it; what waits on you; the profile's pinned items; its
 * spaces as sections of one list, or the same sessions by time; and New space at the foot. The app's
 * destinations are the rail's. It lists SESSIONS — a terminal, a browser or a diff is something a
 * session opens, and lives in that session's side pane, not here.
 *
 * One scroller holds the list, so a long one lengthens the column rather than pushing anything
 * around; it dissolves at an end only while there are rows past it (`useDissolve`), so the list at
 * rest starts close under the profile with its first row whole.
 *
 * The column is a box that opens and closes (`--sidebar-open`, styles.css) and everything in it rides
 * one wrapper that slides with its edge (`.sidebar-slide`): head and list move together, clipped to
 * the column, so nothing of the sidebar is ever drawn over the rail or under the traffic lights.
 */
export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const lens = useApp((s) => s.sidebarLens);
  // A page over the panes whose own rail has this column (components/page-nav.tsx). Its spaces stay
  // mounted underneath, hidden, so coming Back finds them as they were left.
  const pageNav = usePageNavHost();
  const page = collapsed ? null : pageNav?.claimed ?? null;
  const hydrateSidebarPrefs = useApp((s) => s.hydrateSidebarPrefs);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => hydrateSidebarPrefs()); }, [hydrateSidebarPrefs, run]);
  const state = useSidebarState();
  const rows = useProfileRows(state);
  const refresh = useAllItemsFresh();
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  return (
    <aside id="app-sidebar" className="sidebar" data-collapsed={collapsed || undefined} inert={collapsed || undefined}
      data-page-nav={page !== null || undefined}>
      <div className="sidebar-slide">
        <SidebarHeader />
        {page !== null && pageNav && <PageNavColumn label={page.label} back={page.back} title={page.title} setSlot={pageNav.setSlot} />}
        <div className="sb-list" hidden={page !== null || undefined}>
          {/* The profile is what the column lists, so it heads the column — outside the scroller, where
              it holds still while the spaces move under it. */}
          <div className="sb-title"><ProfileSwitcher /></div>
          <div className="space-body" ref={scroller}>
            <NeedsYou />
            <Pinned onChanged={refresh} />
            <SidebarLens />
            {lens === "recent"
              ? <RecentList rows={rows} onChanged={refresh} />
              : <SpaceSections state={state} rows={rows} onChanged={refresh} />}
          </div>
          {/* Pinned at the column's foot rather than at the list's end, where a long list carried it out
              of sight (the owner, 10-04: "the button disappears when the list is too long"). The list
              dissolves into it while rows run on below. In both readings: a space is the one thing
              either list cannot make for you. */}
          <div className="sb-foot"><NewSpaceRow /></div>
        </div>
      </div>
      {/* Inside the column rather than between it and the panes, so that `inert` above reaches it:
          a collapsed sidebar is off-screen, and a handle for a column nobody can see would still
          answer the keyboard. On the column, not the slide: it is the column's edge that it moves. */}
      <SidebarResizer />
      {/* The column's shade on the rail (styles.css): the column's own, so it is the column's width
          on every frame of the fold and leaves with it. */}
      <span className="sidebar-shade" aria-hidden="true" />
    </aside>
  );
}

/**
 * The column while a page's rail has it: the slot the page draws its rail into, under a Back that
 * closes the page and gives the spaces back when the page asks for one (`PageRail`'s `back`). Back is
 * the column's own way out for a page opened from a menu — the page's bar draws no close, and nothing
 * on the rail is lit — because a sidebar that changed what it lists needs to say, where it changed,
 * how to change it back. It stands where the profile does, at the head of what the column lists.
 * Escape goes back from every page, with or without it. A page the rail opened is headed by its name
 * instead, where its sections bring no head of their own (`PageRail`'s `title`).
 */
function PageNavColumn({ label, back, title, setSlot }: {
  label: string; back: boolean; title: string | null; setSlot: (el: HTMLElement | null) => void;
}) {
  const close = useApp((s) => s.closePageOverlay);
  /* The slot scrolls when a page's rail is longer than the column, and dissolves like the spaces it
     stands in for. The page finds it through the same ref, handed over before the first paint. */
  const nav = useRef<HTMLDivElement>(null);
  useDissolve(nav);
  useLayoutEffect(() => { setSlot(nav.current); return () => setSlot(null); }, [setSlot]);
  return (
    <div className="sb-page">
      {back && (
        <div className="sb-page-head">
          <button type="button" className="sb-page-back" title={`Close ${label} and go back to your spaces (Esc)`} onClick={close}>
            <Icon name="chevronLeft" size={14} /><span>Back</span>
          </button>
        </div>
      )}
      {/* Outside the slot's scroller, as Scheduled's and Code review's heads are outside theirs, so the
          name holds still over the sections. An h2: the page's one h1 is its own head, which names the
          section it shows. */}
      {title !== null && <div className="sb-page-head"><h2 className="sb-page-title">{title}</h2></div>}
      <div className="sb-page-nav" ref={nav} />
    </div>
  );
}

/** The profile's own favourites, from any of its spaces, with the state their rows below wear. */
function Pinned({ onChanged }: { onChanged: () => void }) {
  const state = useSidebarState();
  const spaces = useProfileSpaces();
  const items = useMemo(() => pinnedItems(state, spaces), [state, spaces]);
  const spaceName = useCallback((id: string) => spaces.find((sp) => sp.id === id)?.name, [spaces]);
  const open = useOpenAnywhere();
  if (items.length === 0) return null;
  return (
    <section className="sb-pinned" aria-label="Pinned">
      <div className="group-label">Pinned</div>
      <PinnedList items={items} state={state} spaceName={spaceName} onOpen={open} onChanged={onChanged} />
    </section>
  );
}

/** New space, at the foot of the column. */
function NewSpaceRow() {
  const openSheet = useApp((s) => s.openSheet);
  return (
    <button type="button" className="item-row sb-new-space" onClick={() => openSheet({ kind: "new-space" })}>
      <Icon name="add" size={16} /><span>New space</span>
    </button>
  );
}
