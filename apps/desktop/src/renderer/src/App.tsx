import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import { dismissBootSplash } from "./boot-splash";
import { bannerFor, type DaemonUiState } from "./components/daemon-banner";
import { Sidebar } from "./components/sidebar/Sidebar";
import { Rail } from "./components/sidebar/Rail";
import { WindowLead } from "./components/sidebar/WindowLead";
import { SidePaneToggle } from "./components/SidePaneToggle";
import { NewSpaceSheet } from "./components/sidebar/NewSpaceSheet";
import { NewProfileSheet } from "./components/profiles/NewProfileSheet";
import { ProfileWindowBridge } from "./components/profiles/ProfileWindowBridge";
import { NewLectureSheet, WrapUpLectureSheet } from "./components/LectureSheets";
import { SessionPlanSheet } from "./panes/session/SessionSummary";
import { PlynnImportSheet } from "./components/PlynnImportSheet";
import { RemoveWorktreeSheet } from "./components/RemoveWorktreeSheet";
import { FanOutSheet } from "./components/FanOutSheet";
import { CheckpointsSheet } from "./components/CheckpointsSheet";
import { ActivitySheet } from "./components/ActivitySheet";
import { CommandPalette } from "./components/CommandPalette";
import { Toasts } from "./components/Toasts";
import { AppPickerBridge } from "./app-pick/AppPicker";
import { QuickChat } from "./components/QuickChat";
import { MediaViewer } from "./components/viewer/MediaViewer";
import { PageOverlay } from "./components/PageOverlay";
import { PageNavProvider } from "./components/page-nav";
import { SpaceOverview } from "./components/sidebar/SpaceOverview";
import { useKonami } from "./use-konami";
import { useKeybindings, useMenuBar } from "./keys";
import { PaneHost } from "./components/PaneHost";
import { getTerminalHub } from "./panes/terminal-hub";
import { getBrowserBridges } from "./panes/browser/browser-client";
import { persistBrowserPages } from "./panes/browser/persist-pages";
import { Onboarding } from "./components/Onboarding";
import { StoreContext, createAppStore, useApp, useAppStore, type AppState } from "./state/store";
import { sidebarHidden } from "./state/selectors";
import { useStore, type StoreApi } from "zustand";
import { liveApi } from "./state/live-api";
import { rpc } from "./rpc/client";
import { allItems, emptyLayout, type EventName, type EventPayload, type Item, type Layout } from "@realm/contracts";
import { PaneFor } from "./panes/registry";
import { useApplyTheme } from "./theme/useTheme";
import { useZoom } from "./theme/zoom";
import { installRubberBand } from "./rubber-band";
import { installPressTracking } from "./press-tracking";
import { installTooltips } from "./tooltips";
import { installCaret } from "./caret";
import "./panes";

/**
 * The rail, the sidebar column and the content beside it (Plan 27).
 *
 * The rail is the window's left edge in every state, holding the app's destinations. Collapsing — or
 * a page that has no use for the spaces (`PAGE_SHELL`) — closes the sidebar column and nothing else.
 * The top row is the window's: the traffic lights, back and forward stay where they are in both
 * states (WindowLead), and the sidebar's toggle joins them once the column is gone.
 *
 * A page is drawn inside the panes' column, over the panes, so it moves with them: when the sidebar
 * opens or closes, the page and its bar travel in step with the pane bars they cover.
 *
 * Lives under the store provider so it can read the sidebar's state. Exported for the shell tests.
 */
export function AppShell() {
  const collapsed = useApp(sidebarHidden);
  const folded = useSidebarFolded(collapsed);
  // The column's width is painted here rather than on the sidebar itself because the collapse
  // animation is a negative margin of exactly this number: one variable on the shell, read by
  // everything that has to agree with it.
  const width = useApp((s) => s.sidebarWidth);
  /* First run takes the whole window. Nothing in the rail or the sidebar works before a space exists
     — the destinations need one, and the list has nothing in it — so while onboarding is up they are
     away, and what someone sees on their first launch is the one page that is asking them something. */
  const firstRun = useApp((s) => s.booted && s.spaces.length === 0);
  return (
    <div className="app" data-sidebar-collapsed={collapsed || undefined} data-sidebar-folded={folded || undefined}
      data-first-run={firstRun || undefined} style={{ "--sidebar-w": `${width}px` } as CSSProperties}>
      <Rail />
      {/* Mounted whether or not it is showing, so collapsing is a MOVE rather than an unmount —
          there is no exit animation for an element React has already removed. `inert` is what makes
          that safe: a hidden sidebar must not answer the keyboard or a screen reader just because it
          is still in the tree. The cost is that a collapsed sidebar keeps its store subscriptions
          live, which is a list of a few rows re-rendering in the background and the price of the
          thing sliding instead of vanishing. */}
      <Sidebar collapsed={collapsed} />
      {/* App-level pages, over the workspace and never inside it — but inside the column the panes
          are in, so the page's box IS the panes' box: it cannot be a frame behind or ahead of them
          while the sidebar moves, which it was as a window-fixed layer with an inset of its own. */}
      <main className="main"><Main /><PageOverlay /></main>
      {/* After the panes: see WindowLead on why document order is what keeps its buttons clickable. */}
      <WindowLead folded={folded} />
      <SidePaneToggle />
    </div>
  );
}

/**
 * Whether the sidebar has finished folding away, not just been asked to.
 *
 * Two things change hands at that moment rather than at the click: the frame's rim and its corner,
 * which are the column's while any of it is on screen and the panes' once none is
 * (`data-sidebar-folded`), and the toggle, which the column's own head row carries out and the
 * window's lead takes over once the column is gone. Opening hands both back at once. The wait is the
 * column's own transition, read off it, so under reduced motion — which has none — it folds at once.
 */
function useSidebarFolded(collapsed: boolean): boolean {
  const [folded, setFolded] = useState(collapsed);
  useLayoutEffect(() => {
    if (!collapsed) { setFolded(false); return; }
    const column = document.getElementById("app-sidebar");
    const ms = column ? parseFloat(getComputedStyle(column).transitionDuration) * 1000 : 0;
    if (!(ms > 0)) { setFolded(true); return; }
    const timer = window.setTimeout(() => setFolded(true), ms);
    return () => window.clearTimeout(timer);
  }, [collapsed]);
  return folded;
}

/** Writes the active space's palette to :root; lives under the store provider so it can read state. */
/**
 * Whether the app's decorative motion is allowed to run right now, stamped on `:root` for the
 * stylesheet to answer to.
 *
 * Two reasons it stops: the window does not have the user's attention, or they asked for it to stay
 * off. The first is the one that matters for a laptop — an agent working for an hour while its
 * person is in another app used to cost exactly what one being watched costs, and measured
 * (`scripts/power-audit.mjs`) that is about half a core per pane.
 *
 * `blur`/`focus` on the window rather than `visibilitychange`: Chromium already stops servicing a
 * window it considers hidden, and the case that was costing power is the one it does NOT consider
 * hidden — Realm sitting in full view beside the editor someone is actually typing in.
 */
function QuietBridge() {
  const lowPower = useApp((s) => s.lowPower);
  const windowActive = useApp((s) => s.windowActive);
  const setWindowActive = useApp((s) => s.setWindowActive);

  useEffect(() => {
    const active = () => setWindowActive(true);
    const idle = () => setWindowActive(false);
    window.addEventListener("focus", active);
    window.addEventListener("blur", idle);
    // The window can also be hidden outright — minimised, or on another Space. Chromium throttles
    // that case itself, but the attribute should agree with reality either way.
    const visibility = () => setWindowActive(document.visibilityState === "visible" && document.hasFocus());
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      window.removeEventListener("focus", active);
      window.removeEventListener("blur", idle);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [setWindowActive]);

  useEffect(() => {
    const quiet = lowPower || !windowActive;
    if (quiet) document.documentElement.setAttribute("data-quiet", lowPower ? "always" : "unfocused");
    else document.documentElement.removeAttribute("data-quiet");
  }, [lowPower, windowActive]);
  return null;
}

/**
 * Whether this is the key window, stamped on `:root` as `data-window-inactive` when it is not.
 *
 * A Mac window that loses the keyboard steps its emphasis down: the selection, the default button and
 * every accent-filled control go grey, and come back the moment the window does. It is how a person
 * sees at a glance which window their typing will land in, and an app that stays lit in the
 * background is one that does not know it is a Mac app. The stylesheet does the greying; this only
 * says when. Separate from `QuietBridge` on purpose: that one answers the PAGE's focus, which a click
 * into a browser pane takes away while the window stays key.
 */
export function KeyWindowBridge() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = (key: boolean) => {
      if (key) root.removeAttribute("data-window-inactive");
      else root.setAttribute("data-window-inactive", "");
    };
    // Subscribe first, then ask: a change that lands between the two is reported by the push, and
    // the answer to the ask can only be as old as the subscription. Asking matters for a window that
    // opened behind another app — it never had a focus change to report.
    let pushed = false;
    const off = window.realm?.onWindowKey?.((key) => { pushed = true; apply(key); });
    void window.realm?.isWindowKey?.().then((key) => { if (!pushed) apply(key); }).catch(() => {});
    return () => { off?.(); root.removeAttribute("data-window-inactive"); };
  }, []);
  return null;
}

/**
 * Whether the system draws OVERLAY scrollbars — macOS's "show scroll bars: when scrolling", which is
 * also what "automatically" resolves to on a Mac with only a trackpad. Stamped on `:root` as
 * `data-overlay-scrollbars`, and the stylesheet's own scrollbar treatment stands down under it.
 *
 * Realm's thin line is a better classic scrollbar than the classic one, and on an overlay Mac it is
 * worse than the system's. Chromium keeps the overlay bar when a page only colours or thins it, but
 * paints it in the page's colour instead of the system's; and a `::-webkit-scrollbar` rule — which the
 * sidebar and every masked scroller need, for their track margins — turns it into a classic bar that
 * holds a gutter (measured on an overlay Mac: 8px against 0). So the styling is for the Macs whose
 * system draws classic bars anyway, and the rest get the system's own bar.
 *
 * Measured, not read from a preference: "automatically" depends on what is plugged in, and the only
 * party that knows the answer is the scroller Chromium draws. A probe with every scrollbar property
 * at its default reserves no width exactly when the system bar is an overlay. Re-measured when the
 * window comes forward, because plugging a mouse in changes the answer under a running app.
 */
export function overlayScrollbars(doc: Document): boolean {
  const probe = doc.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden;scrollbar-color:auto;scrollbar-width:auto";
  doc.body.appendChild(probe);
  const reserved = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return reserved === 0;
}

function ScrollbarStyleBridge() {
  useEffect(() => {
    // jsdom lays nothing out, so every probe there reads as an overlay; only a real Mac window asks.
    if (window.realm?.platform !== "darwin") return;
    const root = document.documentElement;
    const measure = () => {
      if (overlayScrollbars(document)) root.setAttribute("data-overlay-scrollbars", "");
      else root.removeAttribute("data-overlay-scrollbars");
    };
    measure();
    window.addEventListener("focus", measure);
    return () => { window.removeEventListener("focus", measure); root.removeAttribute("data-overlay-scrollbars"); };
  }, []);
  return null;
}

/** A held button's highlight follows the pointer (press-tracking.ts). */
function PressTrackingBridge() {
  useEffect(() => installPressTracking(document), []);
  return null;
}

/** Every control's `title` as the app's own tooltip (tooltips.ts), kept clear of the browser views. */
function TooltipBridge() {
  const store = useAppStore();
  useEffect(() => installTooltips(document, { avoid: () => store.getState().browserRects }), [store]);
  return null;
}

/** The app's caret over every field (caret.ts), in the shape and motion Settings ▸ Appearance ▸ Cursor
 *  chose. Subscribed rather than rendered: the layer is the DOM's, and a new preference reaches it
 *  without re-rendering anything. */
function CaretBridge() {
  const store = useAppStore();
  useEffect(() => {
    const layer = installCaret(document, store.getState().caret);
    const off = store.subscribe((s, prev) => { if (s.caret !== prev.caret) layer.configure(s.caret); });
    return () => { off(); layer.uninstall(); };
  }, [store]);
  return null;
}

/** The app's scrollers give at their ends (rubber-band.ts). Off under reduced motion, as AppKit's is. */
function RubberBandBridge() {
  useEffect(() => installRubberBand(document, {
    onPhase: window.realm?.onScrollPhase,
    reducedMotion: () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  }), []);
  return null;
}

export function ThemeBridge() {
  const color = useApp((s) => s.activeSpace()?.color ?? null);
  const pref = useApp((s) => s.themePref);
  const themes = useApp((s) => s.themeNames);
  const overrides = useApp((s) => s.themeOverrides);
  const contrast = useApp((s) => s.contrast);
  const fonts = useApp((s) => s.fonts);
  const groundAlpha = useApp((s) => s.groundAlpha);
  const paneAlpha = useApp((s) => s.paneAlpha);
  const cursorBlink = useApp((s) => s.terminalCursorBlink);
  const cursorStyle = useApp((s) => s.terminalCursorStyle);
  const terminalScheme = useApp((s) => s.terminalColors);
  /* The page zoom, onto `:root` as a number the stylesheet multiplies by. Chromium already scales
     every px when you press ⌘−; what this buys is the surfaces that should give up MORE than their
     share when you do — the prompter's column, today. */
  useZoom();
  const mode = useApplyTheme({ color, pref, themes, overrides, contrast, fonts, groundAlpha, paneAlpha });
  // xterm reads its font once, at construction, so a terminal already on screen would keep the old
  // face. A plain effect, not a layout one: it has to run AFTER useApplyTheme has written
  // --font-mono, because the hub reads the computed value off :root.
  useEffect(() => { getTerminalHub().refreshFont(); }, [fonts]);
  // The same for its colours, which are the face's: a terminal opened in dark mode keeps white ink
  // that the light face's ground would swallow. `mode` rather than `pref`, because "System" changes
  // face without the preference changing.
  useEffect(() => { getTerminalHub().refreshColors(); }, [mode, color, themes, overrides, contrast]);
  // Realm's sixteen or the shell's: the colours again, for the same reason.
  useEffect(() => { getTerminalHub().setColorScheme(terminalScheme); }, [terminalScheme]);
  // Whether that cursor blinks is the same story: xterm takes it at construction, and a preference
  // that only reached the NEXT terminal is one nobody believes they changed.
  useEffect(() => { getTerminalHub().setCursorBlink(cursorBlink); }, [cursorBlink]);
  useEffect(() => { getTerminalHub().setCursorStyle(cursorStyle); }, [cursorStyle]);
  // Same shape, same reason (Plan 25 W1): main draws the agent's action ring, cursor and
  // controlled-screen frame INSIDE the page, where none of Realm's CSS reaches, so the accent has to
  // be pushed to it. Read off the live document rather than derived from the store, because the
  // value that matters is the one the page will actually be painted beside — the same resolved
  // colour every other surface in the window is using, and the same read the picker already makes.
  // Every input `useApplyTheme` takes is a dependency: any one of them can move the accent.
  useEffect(() => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--rl-accent").trim();
    // Empty under jsdom, which loads no stylesheet — so a test renders this component and pushes
    // nothing, rather than pushing a colour that is not one.
    if (accent) getBrowserBridges().host.setAccent(accent);
  }, [color, pref, themes, overrides, contrast, fonts, groundAlpha, paneAlpha]);
  return null;
}

/**
 * Slim persistent banner about the server underneath the app.
 *
 * It used to say one thing — "reconnecting…" — which is honest about a dropped socket and a lie about
 * a server that has stopped for good. Main can tell those apart and this subscribes to what it says;
 * the words themselves live in `bannerFor`, so what is claimed in each state is testable without a
 * window. `role="status"` for the ones you wait out, `alert` for the ones you have to act on.
 */
function ConnectionBanner() {
  const connectionDown = useApp((s) => s.connectionState !== "connected");
  const [daemon, setDaemon] = useState<DaemonUiState | null>(null);
  useEffect(() => window.realm?.onDaemonState?.((state) => setDaemon(state as DaemonUiState)), []);
  const copy = bannerFor({ connectionDown, daemon });
  if (!copy) return null;
  return (
    <div className="conn-banner" data-tone={copy.tone} role={copy.tone === "bad" ? "alert" : "status"}>
      <span>{copy.text}</span>
      {copy.action === "retry" && <button onClick={() => rpc().retryNow()}>Retry</button>}
      {copy.action === "quit-and-stop" && (
        <button onClick={() => void window.realm?.quitAndStopAgents?.()}>Quit &amp; stop agents</button>
      )}
    </div>
  );
}

/** Renders whichever modal sheet the store says is open. */
function SheetHost() {
  const sheet = useApp((s) => s.sheet);
  if (!sheet) return null;
  if (sheet.kind === "new-space") return <NewSpaceSheet />;
  if (sheet.kind === "new-profile") return <NewProfileSheet />;
  if (sheet.kind === "remove-worktree") return <RemoveWorktreeSheet environmentId={sheet.environmentId} />;
  if (sheet.kind === "checkpoints") return <CheckpointsSheet environmentId={sheet.environmentId} sessionId={sheet.sessionId} />;
  if (sheet.kind === "activity") return <ActivitySheet />;
  if (sheet.kind === "new-lecture") return <NewLectureSheet />;
  if (sheet.kind === "wrap-up-lecture") return <WrapUpLectureSheet />;
  if (sheet.kind === "plynn-import") return <PlynnImportSheet />;
  if (sheet.kind === "session-plan") return <SessionPlanSheet sessionId={sheet.sessionId} planId={sheet.planId} />;
  if (sheet.kind === "fan-out") return <FanOutSheet />;
  return null;
}

/** Full-bleed PaneHost for the window's one view: a pane, or a split of two, each with its own side
 *  pane — no bar of named splits above it. Exported for the app-shell tests. */
export function Main() {
  const layout = useApp((s) => s.layout);
  const spaceItems = useApp((s) => s.items);
  const offscreenBrowsers = useApp((s) => s.offscreenBrowsers);
  /* A peek may be another profile's session, whose row is in no list of this window's — and the host
     draws a tab only from a row it was handed. */
  const peek = useApp((s) => s.peek?.item ?? null);
  const items = useMemo(() => (peek && !spaceItems.some((i) => i.id === peek.id) ? [...spaceItems, peek] : spaceItems), [spaceItems, peek]);
  const spaceId = useApp((s) => s.activeSpaceId);
  const booted = useApp((s) => s.booted);
  const spaces = useApp((s) => s.spaces);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const focusLeaf = useApp((s) => s.focusLeaf);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const closeEmptyPane = useApp((s) => s.closeEmptyPane);
  const splitFocused = useApp((s) => s.splitFocused);
  const openItemAt = useApp((s) => s.openItemAt);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const resizeSplit = useApp((s) => s.resizeSplit);
  const equalizeSplit = useApp((s) => s.equalizeSplit);
  const zoomedLeafId = useApp((s) => s.view?.zoomedLeafId ?? null);
  const sidePanesHidden = useApp((s) => s.sidePanesHidden);
  const focusPaneFull = useApp((s) => s.focusPaneFull);
  const unfocusPane = useApp((s) => s.unfocusPane);
  const run = useApp((s) => s.run);
  // The boot mark in index.html comes down when there is something to show — which is `booted`, not
  // mount: this component renders an empty shell for as long as `boot()` is in flight. Declared
  // above the early returns below, because a hook after a `return` is a hook that stops running.
  useEffect(() => { if (booted) dismissBootSplash(); }, [booted]);
  // First run (W4): no spaces at all — the onboarding sheet, not a sentence pointing at a "+". It is
  // gated on `booted` because an unbooted store also has zero spaces, and on the space COUNT rather than
  // `activeSpaceId`, so it can never come back for someone who already has spaces.
  if (booted && spaces.length === 0) return <Onboarding />;
  if (!spaceId) return <div className="pane-placeholder muted">Create a space with the + in the sidebar.</div>;
  return (
    <>
      <PaneHost layout={layout ?? emptyLayout()} items={items} focusedLeafId={focusedLeafId}
        zoomedLeafId={zoomedLeafId} sidePanesHidden={sidePanesHidden}
        onZoom={(leafId) => run(() => focusPaneFull(leafId))}
        onUnzoom={() => run(() => unfocusPane())}
        onFocus={focusLeaf}
        onClose={(id) => run(() => closeFromLayout(id))}
        onCloseEmpty={(leafId) => run(() => closeEmptyPane(leafId))}
        // The split button targets its own leaf: focus it synchronously, then split reads the fresh focus.
        onSplit={(leafId, dir) => { focusLeaf(leafId); run(() => splitFocused(dir)); }}
        onResize={resizeSplit}
        onEqualize={equalizeSplit}
        onDropItem={(id, leafId, edge) => run(() => openItemAt(id, leafId, edge))}
        onDropNewSession={(leafId, edge) => run(() => newSessionInstant(leafId, edge))} />
      <OffscreenBrowsers ids={offscreenBrowsers} layout={layout} items={items} />
    </>
  );
}

/**
 * The browsers an agent opened for a session that is not on screen, mounted hidden so the agent can
 * drive them (`offscreenBrowsers`). A browser's native view exists only while a pane holds it; these
 * are in that session's side pane off screen, and come into view with it — at which point the pane
 * host mounts them instead, and the hidden mount here steps aside in the same render.
 */
function OffscreenBrowsers({ ids, layout, items }: { ids: string[]; layout: Layout | null; items: Item[] }) {
  const onScreen = new Set(layout ? allItems(layout) : []);
  const hidden = ids.filter((id) => !onScreen.has(id)).map((id) => items.find((i) => i.id === id)).filter((i): i is Item => i?.kind === "browser");
  if (hidden.length === 0) return null;
  return (
    <div className="offscreen-panes" hidden aria-hidden="true">
      {hidden.map((it) => <div key={it.id} className="pane-slot"><PaneFor item={it} visible={false} focused={false} /></div>)}
    </div>
  );
}

/** `rpc().on`, as the subscriptions below take it — a seam, so their tests hand in a recorder. */
type Subscribe = <E extends EventName>(event: E, fn: (payload: EventPayload<E>) => void) => () => void;

/**
 * The broadcasts that say one space's lists changed — its items (and with them its sessions), its
 * checkouts, its scripts — heard for EVERY space of the window's profile, not just the current one.
 * Every space of the profile is loaded at once, so a list left stale because its space was not the one
 * in focus would be a sidebar showing a session that was deleted, or missing one an agent just made.
 * `spaceScripts` is what `ownsScriptCommand` consults synchronously on a keystroke, so a stale copy is
 * a bound key that runs a script the user just deleted. Exported for its test.
 */
export function subscribeSpaceLists(store: StoreApi<AppState>, on: Subscribe): () => void {
  const mine = (spaceId: string) => {
    const st = store.getState();
    return st.spaces.some((sp) => sp.id === spaceId && sp.profileId === st.activeProfileId);
  };
  const offs = [
    on("items.changed", ({ spaceId }) => {
      if (!mine(spaceId)) return;
      const st = store.getState();
      st.run(() => st.refreshItems(spaceId));
      st.run(() => st.refreshSessions(spaceId));
    }),
    on("environments.changed", ({ spaceId }) => {
      if (!mine(spaceId)) return;
      const st = store.getState();
      st.run(() => st.refreshEnvironments(spaceId));
    }),
    on("scripts.changed", ({ spaceId }) => {
      if (!mine(spaceId)) return;
      const st = store.getState();
      st.run(() => st.refreshScripts(spaceId));
    }),
  ];
  return () => { for (const off of offs) off(); };
}

/** The broadcasts that bring an agent-opened pane into the layout. Exported for its test. */
export const AGENT_PANE_EVENTS = ["browser.agentOpened", "simulator.agentOpened", "terminal.agentOpened"] as const;

/**
 * An agent opened a browser (`browser_open`), a device (`simulator_open`) or a shell (`terminal_open`):
 * bring it into the layout as a tab of the side pane of the session that opened it, not as a column
 * beside whatever has focus. The user WATCHES what an agent drives, and a browser's native view only
 * exists once its pane mounts. The terminal was the one missing here, so an agent's shell was a row in
 * the sidebar and nowhere on screen.
 */
export function subscribeAgentPanes(store: StoreApi<AppState>, on: Subscribe): () => void {
  const offs = AGENT_PANE_EVENTS.map((event) => on(event, (p) => { const st = store.getState(); st.run(() => st.applyAgentPaneOpened(p)); }));
  return () => { for (const off of offs) off(); };
}

export function App() {
  const store = useMemo(() => createAppStore(liveApi()), []);
  /* One keymap, one handler. The three hooks this replaces each owned a slice of the keyboard and
     each matched loosely — mounting them alongside `useKeybindings` would fire every shipped chord
     twice, which for a toggle like ⌘K means opening and closing the palette in one keystroke.
     `keys` is undefined until the server answers; the hook runs the shipped defaults meanwhile,
     which is what every keystroke before the first round trip had to do anyway. */
  const keys = useStore(store, (s) => s.keybindings);
  useKeybindings(store, keys);
  useMenuBar(store, keys);
  useKonami(store);
  useEffect(() => {
    const load = () => {
      void rpc().call("keybindings.get", {}).then((file) => store.getState().setKeybindings(file.rules)).catch(() => {});
    };
    load();
    return rpc().on("keybindings.changed", load);
  }, [store]);
  useEffect(() => {
    const s = store.getState();
    s.run(() => s.boot());
    const offS = rpc().on("spaces.changed", () => store.getState().run(() => store.getState().refreshSpaces()));
    const offI = subscribeSpaceLists(store, (event, fn) => rpc().on(event, fn));
    // Realm's own write to a working tree. Every held diff is refreshed, not just the one named:
    // two panes may look at one repository through two different cwds, and only the server knows.
    const offW = rpc().on("workspace.changed", () => {
      const st = store.getState();
      st.run(() => st.refreshAllDiffs());
    });
    // A ship-log row was written (Plan 14 W1). Held-only, like skills/memory: the History tab is the
    // one holder, and a space whose log nobody is looking at has nothing to go stale.
    const offSh = rpc().on("ships.changed", ({ spaceId }) => {
      const st = store.getState();
      if (st.ships[spaceId]) st.run(() => st.refreshShips(spaceId));
    });
    // A durable run moved (created, dispatched, blocked, settled). Held-only like ships: the payload
    // carries the fresh row, so a Tasks lens already showing the space applies it without a refetch.
    const offRun = rpc().on("runs.changed", (p) => store.getState().applyRunsChanged(p));
    // A schedule was created, edited, deleted or fired. Held-only like ships: the payload carries no
    // row (a schedule changes rarely, and a deletion has no row to carry), so a page already showing
    // this space re-lists and everyone else does nothing.
    const offSched = rpc().on("schedules.changed", ({ spaceId }) => {
      const st = store.getState();
      if (st.schedules[spaceId]) st.run(() => st.refreshSchedules(spaceId));
    });
    // A checkpoint was taken, restored or pruned. Only re-listed when the sheet is actually showing
    // that environment: this fires on every turn, and a store holding a list nobody is looking at is
    // work for nothing.
    const offP = rpc().on("checkpoints.changed", ({ environmentId }) => {
      const st = store.getState();
      const sheet = st.sheet;
      if (sheet?.kind === "checkpoints" && sheet.environmentId === environmentId) {
        st.run(() => st.refreshCheckpoints(environmentId, sheet.sessionId));
      }
      // …and the whole checkout's list a transcript's edit cards decide Undo by, if one is held.
      if (st.envCheckpoints[environmentId]) st.run(() => st.refreshEnvCheckpoints(environmentId));
    });
    // A skill was toggled (or the library edited). Only spaces already holding a library refresh —
    // the mention picker fetches on session open, so a space nobody is prompting in stays unfetched.
    const offK = rpc().on("skills.changed", ({ spaceId }) => {
      const st = store.getState();
      if (st.spaceSkills[spaceId]) st.run(() => st.refreshSkills(spaceId));
    });
    /* The themes folder changed — imported here, or edited on disk. Unconditional, unlike skills:
       there is one themes folder rather than one per space, and the palette it holds may be the one
       the window is wearing right now. */
    const offTh = rpc().on("themes.changed", () => {
      const st = store.getState();
      st.run(() => st.refreshCustomThemes());
    });
    /* A font family was installed or removed — from this window or another. Unconditional for the
       themes folder's reason: there is one fonts folder, and what it holds may be the face the window
       is wearing right now. */
    const offFo = rpc().on("fonts.changed", () => {
      const st = store.getState();
      st.run(() => st.refreshFonts());
    });
    // The picture on the page about you changed, here or in another window. The payload is the new
    // copy's path, so it is applied as it stands rather than re-read.
    const offAv = rpc().on("avatar.changed", ({ path }) => store.getState().applyAvatarChanged(path));
    // A space's memory document or AGENTS.md changed. Same held-only rule as skills.
    const offMem = rpc().on("memory.changed", ({ spaceId }) => {
      const st = store.getState();
      if (st.spaceMemory[spaceId]) st.run(() => st.refreshMemory(spaceId));
    });
    const offB = subscribeAgentPanes(store, (event, fn) => rpc().on(event, fn));
    // Every browser's page — address, title, icon — saved as it changes, shown in a pane or not: an
    // agent driving a browser nobody is looking at keeps its sidebar row true (persist-pages.ts).
    const offPages = persistBrowserPages(getBrowserBridges());
    // A session delegated a browsing goal to a browser-agent session (Plan 11 W5): same idiom — the
    // child is a real session, and the point of it being one is that the user watches its whole
    // trace, so it comes into the layout the moment it exists. Other spaces gain the sidebar item
    // via items.changed as usual.
    // A file was surfaced in the documents pane (Plan 22) — by the user, or by an agent's `docs_open`.
    // Same idiom as the browser and session openings: into the layout for any space of the window's
    // profile, and quietly, so a guide an agent just wrote appears beside the session without
    // stealing focus.
    const offDO = rpc().on("documents.openRequested", (p) => { const st = store.getState(); st.run(() => st.applyDocumentOpenRequested(p)); });
    const offSA = rpc().on("session.agentOpened", (p) => { const st = store.getState(); st.run(() => st.applyAgentOpened(p)); });
    // The same child's run settled. A clean finish reads its "Finished a turn" row (`applyAgentSettled`).
    const offSS = rpc().on("session.agentSettled", (p) => store.getState().applyAgentSettled(p));
    // W4's watching feed: settled actions into the pane chrome's ticker, in-flight acts onto the
    // driving dot. Applied for every space (like session.status) — the maps are cheap and a switch
    // back should find the ticker already truthful.
    const offBA = rpc().on("browser.action", (p) => store.getState().applyBrowserAction(p));
    const offBD = rpc().on("browser.driving", (p) => store.getState().applyBrowserDriving(p));
    const offTD = rpc().on("terminal.driving", (p) => store.getState().applyTerminalDriving(p));
    // Machines (Plan 25 W3), on the same terms and for the same reason: the sidebar's dot and the
    // pane's body read one map, and a switch back to a space should find it already truthful.
    const offMach = rpc().on("machine.status", (p) => store.getState().applyMachineState(p));
    const offSim = rpc().on("simulator.status", (p) => store.getState().applySimulatorState(p));
    const offGoal = rpc().on("goal.changed", (p) => store.getState().applyGoalChanged(p));
    const offMimg = rpc().on("machineImage.progress", (p) => store.getState().applyMachineImageProgress(p));
    const offE = rpc().on("session.event", (ev) => store.getState().applySessionEvent(ev));
    const offT = rpc().on("session.status", ({ sessionId, status }) => store.getState().applySessionStatus(sessionId, status));
    // The queue behind a running turn. Applied in every window for the reason the statuses are: the
    // session's pane may be open in any of them, and the payload is a handful of short strings.
    const offQ = rpc().on("session.queue", ({ sessionId, queued }) => store.getState().applySessionQueue(sessionId, queued));
    // The account's plan quota, restated by whichever provider just heard about it. Applied in every
    // window: the figure is about the account, so every window is looking at the same one.
    const offPL = rpc().on("limits.changed", ({ limits }) => store.getState().applyPlanLimits(limits));
    // The feed (Plan 12 W5): every change carries the server's unread count for the sidebar pill, and
    // a surfaced row for the focused-pane auto-read — see applyNotificationsChanged.
    const offN = rpc().on("notifications.changed", (p) => store.getState().applyNotificationsChanged(p));
    // A clicked OS toast, arriving from main as a bare row id (main/notify.ts). Optional-chained like
    // onScrollPhase: a renderer running outside the Electron preload (tests, a browser) simply never
    // hears one. Main has already raised the window; the store owns landing on the row.
    const offDN = window.realm?.notify?.onActivate((id) => {
      const st = store.getState();
      st.run(() => st.activateDesktopNotification(id));
    });
    // A session chosen from the menu-bar item while this window did not exist. Main has already
    // brought the window back; landing on the pane is the store's job, exactly as it is for a toast.
    const offOS = window.realm?.onOpenSession?.(({ sessionId, spaceId }) => {
      const st = store.getState();
      st.run(() => st.revealSession(sessionId, spaceId));
    });
    // A review verdict landed (or was dismissed/cleared) for an environment (Plan 13 W3): apply the
    // payload directly — the diff pane's review section reads `reviews[environmentId]`.
    const offR = rpc().on("review.changed", (p) => store.getState().applyReviewChanged(p));
    // The set of sessions a session is waiting on. Applied in every window and gated on
    // nothing: the delegating session's pane may be open in any of them, and the payload is a
    // handful of ids — the store drops the key when the set is empty.
    const offDel = rpc().on("delegation.changed", (p) => store.getState().applyDelegationChanged(p));
    // No payload — `mcp.changed` just means "something about some server changed". Only worth a refetch
    // while a space page's Connections tab is actually mounted on a space's server list (Plan 12 W3:
    // the settings sheet is gone; `mcpPanelSpaceId` is McpSection's mounted-for-which-space record).
    const offM = rpc().on("mcp.changed", () => {
      const st = store.getState();
      const panelSpaceId = st.mcpPanelSpaceId;
      if (panelSpaceId) st.run(() => st.refreshMcpServers(panelSpaceId));
      // The plus-menu's per-space cache (Plan 12 W1): only spaces already fetched — a space whose menu
      // was never opened has nothing to go stale.
      for (const spaceId of Object.keys(st.connectors)) st.run(() => st.refreshConnectors(spaceId));
    });
    // A running install's narration and its outcome. Broadcast, so both the Settings engines list and
    // a session's install card follow the same install; the store drops anything it did not start.
    const offCO = rpc().on("cli.output", (e) => store.getState().applyCliOutput(e));
    const offCD = rpc().on("cli.done", (e) => {
      const st = store.getState();
      st.applyCliDone(e);
      // The server re-probed before sending this, so an unforced read is already the new truth.
      st.run(() => st.refreshCliStatus());
      st.run(() => st.probeAgents(true));
    });
    // A first-run sign-in moving: the browser page up, a code asked for, signed in. Broadcast, so the
    // store keeps the latest per agent and drops a replaced one's late word.
    const offASI = rpc().on("agentSignIn.changed", (e) => store.getState().applyAgentSignIn(e));
    const offMS = rpc().on("mcp.serverStatus", (payload) => store.getState().applyMcpServerStatus(payload));
    // Laya's status, whole: an install narrating its steps, the runtime coming up or going down, and
    // the step count while agents work — all of it the Settings section's one state line.
    const offLaya = rpc().on("laya.changed", (status) => store.getState().applyLaya(status));
    // Broadcast for EVERY space/session (binding rule 5) — applyMcpCall itself is the gate on whether
    // Activity is even open and whether the row matches its filter, same as mcp.serverStatus above.
    const offMC = rpc().on("mcp.call", (call) => store.getState().applyMcpCall(call));
    const offC = rpc().onStatusChange((state) => store.getState().applyConnectionState(state));
    // Quit/reload with a resize inside the persist debounce window would silently lose it (A-M4).
    const onPageHide = () => { store.getState().flushPersist().catch(() => {}); }; // best-effort: socket may be gone at quit
    window.addEventListener("pagehide", onPageHide);
    // A file dropped anywhere OUTSIDE the prompter would otherwise be navigated to — in a packaged
    // build the app itself is a file:// document, so main's will-navigate guard reads that as in-app
    // and lets it through, replacing Realm with the dropped file. The prompter's own handlers call
    // preventDefault first, so they are unaffected; this only catches the misses.
    const swallowDrop = (e: Event) => e.preventDefault();
    window.addEventListener("dragover", swallowDrop);
    window.addEventListener("drop", swallowDrop);
    return () => {
      offS(); offI(); offW(); offSh(); offRun(); offSched(); offP(); offK(); offTh(); offFo(); offAv(); offMem(); offB(); offPages(); offDO(); offSA(); offSS(); offBA(); offBD(); offTD(); offMach(); offSim(); offGoal(); offMimg(); offE(); offT(); offQ(); offPL(); offN(); offDN?.(); offR(); offDel(); offM(); offMS(); offASI(); offLaya(); offMC(); offCO(); offCD(); offC();
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("dragover", swallowDrop);
      window.removeEventListener("drop", swallowDrop);
      offOS?.();
    };
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <ThemeBridge />
      <QuietBridge />
      <KeyWindowBridge />
      <ProfileWindowBridge />
      <ScrollbarStyleBridge />
      <RubberBandBridge />
      <PressTrackingBridge />
      <TooltipBridge />
      <CaretBridge />
      {/* Shared by the sidebar and the page over the panes, whose own rail can take the sidebar's
          column (components/page-nav.tsx). */}
      <PageNavProvider>
      <AppShell />
      <ConnectionBanner />
      </PageNavProvider>
      <SheetHost />
      {/* Over everything and outside the layout: it takes no pane, so it belongs to the window
          rather than to any one space's arrangement of it. */}
      <QuickChat />
      {/* Every file the app shows opens here, over the window, with the session's prompter under it. */}
      <MediaViewer />
      <CommandPalette />
      <SpaceOverview />
      {/* What the window has to say, at its foot and over everything: a failed action, a receipt. */}
      <Toasts />
      {/* Select in Realm: the element picker over this window, above everything it can point at. */}
      <AppPickerBridge />
    </StoreContext.Provider>
  );
}
