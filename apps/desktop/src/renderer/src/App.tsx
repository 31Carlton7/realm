import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { dismissBootSplash } from "./boot-splash";
import { bannerFor, type DaemonUiState } from "./components/daemon-banner";
import { Sidebar } from "./components/sidebar/Sidebar";
import { SidebarToggle } from "./components/sidebar/SidebarToggle";
import { NewSpaceSheet } from "./components/sidebar/NewSpaceSheet";
import { NewLectureSheet, WrapUpLectureSheet } from "./components/LectureSheets";
import { ArtifactSheet, SessionPlanSheet } from "./panes/session/SessionSummary";
import { PlynnImportSheet } from "./components/PlynnImportSheet";
import { RemoveWorktreeSheet } from "./components/RemoveWorktreeSheet";
import { CheckpointsSheet } from "./components/CheckpointsSheet";
import { ActivitySheet } from "./components/ActivitySheet";
import { CommandPalette } from "./components/CommandPalette";
import { QuickChat } from "./components/QuickChat";
import { PageOverlay } from "./components/PageOverlay";
import { SpaceOverview } from "./components/sidebar/SpaceOverview";
import { useKonami } from "./use-konami";
import { useKeybindings } from "./keys";
import { PaneHost } from "./components/PaneHost";
import { getTerminalHub } from "./panes/terminal-hub";
import { getBrowserBridges } from "./panes/browser/browser-client";
import { GroupBar } from "./components/GroupBar";
import { Onboarding } from "./components/Onboarding";
import { StoreContext, createAppStore, useApp } from "./state/store";
import { useStore } from "zustand";
import { liveApi } from "./state/live-api";
import { rpc } from "./rpc/client";
import { emptyLayout } from "@realm/contracts";
import { useApplyTheme } from "./theme/useTheme";
import "./panes";

/**
 * The sidebar column and the content beside it — or, collapsed, a top rail and the content below it.
 *
 * The two states are one row, not two layouts: collapsed, the column is gone and the content takes
 * the whole window. What is left to place is the macOS traffic lights, which have no sidebar to sit
 * in any more and would otherwise land on the first pane's title.
 *
 * They land on the first pane's BAR, and the corner that holds them is an overlay — absolutely
 * positioned, no height of its own — so collapsing buys back the whole column and costs nothing. It
 * used to cost a 38px full-width rail whose only content was this one button, which is a strip of
 * chrome across every pane forever in exchange for a corner. The strip beneath the lights reserves
 * their width instead (see --corner-w in styles.css).
 *
 * The corner is rendered AFTER main and carries a z-index: panes are positioned elements, so DOM
 * order alone would put the first pane's bar on top of it.
 *
 * Lives under the store provider so it can read `sidebarCollapsed`. Exported for the shell tests.
 */
export function AppShell() {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  // The column's width is painted here rather than on the sidebar itself because the collapse
  // animation is a negative margin of exactly this number, and `.sb-corner` is placed against the
  // same edge: one variable on the shell, read by everything that has to agree with it.
  const width = useApp((s) => s.sidebarWidth);
  return (
    <div className="app" data-sidebar-collapsed={collapsed || undefined}
      style={{ "--sidebar-w": `${width}px` } as CSSProperties}>
      {/* Mounted whether or not it is showing, so collapsing is a MOVE rather than an unmount —
          there is no exit animation for an element React has already removed. `inert` is what makes
          that safe: a hidden sidebar must not answer the keyboard or a screen reader just because it
          is still in the tree. The cost is that a collapsed sidebar keeps its store subscriptions
          live, which is a list of a few rows re-rendering in the background and the price of the
          thing sliding instead of vanishing. */}
      <Sidebar collapsed={collapsed} />
      <main className="main"><Main /></main>
      {collapsed && <div className="sb-corner"><SidebarToggle /></div>}
    </div>
  );
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

function ThemeBridge() {
  const color = useApp((s) => s.activeSpace()?.color ?? null);
  const pref = useApp((s) => s.themePref);
  const themes = useApp((s) => s.themeNames);
  const overrides = useApp((s) => s.themeOverrides);
  const contrast = useApp((s) => s.contrast);
  const fonts = useApp((s) => s.fonts);
  const groundAlpha = useApp((s) => s.groundAlpha);
  useApplyTheme({ color, pref, themes, overrides, contrast, fonts, groundAlpha });
  // xterm reads its font once, at construction, so a terminal already on screen would keep the old
  // face. A plain effect, not a layout one: it has to run AFTER useApplyTheme has written
  // --font-mono, because the hub reads the computed value off :root.
  useEffect(() => { getTerminalHub().refreshFont(); }, [fonts]);
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
  }, [color, pref, themes, overrides, contrast, fonts, groundAlpha]);
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

function ErrorBar() {
  const error = useApp((s) => s.error);
  const clearError = useApp((s) => s.clearError);
  // The fixed conn-banner hangs over the top edge where this bar sits; step below it while it shows.
  const underBanner = useApp((s) => s.connectionState !== "connected");
  if (!error) return null;
  return (
    <div className="error-bar" data-under-banner={underBanner || undefined} role="alert">
      <span>{error}</span>
      <button aria-label="Dismiss error" onClick={clearError}>✕</button>
    </div>
  );
}

/** Renders whichever modal sheet the store says is open. */
function SheetHost() {
  const sheet = useApp((s) => s.sheet);
  if (!sheet) return null;
  if (sheet.kind === "new-space") return <NewSpaceSheet />;
  if (sheet.kind === "remove-worktree") return <RemoveWorktreeSheet environmentId={sheet.environmentId} />;
  if (sheet.kind === "checkpoints") return <CheckpointsSheet environmentId={sheet.environmentId} sessionId={sheet.sessionId} />;
  if (sheet.kind === "activity") return <ActivitySheet />;
  if (sheet.kind === "new-lecture") return <NewLectureSheet />;
  if (sheet.kind === "wrap-up-lecture") return <WrapUpLectureSheet />;
  if (sheet.kind === "plynn-import") return <PlynnImportSheet />;
  if (sheet.kind === "artifact") return <ArtifactSheet path={sheet.path} />;
  if (sheet.kind === "session-plan") return <SessionPlanSheet sessionId={sheet.sessionId} planId={sheet.planId} />;
  return null;
}

/** Full-bleed PaneHost for the active space, under the GroupBar — which renders NOTHING unless the
 *  space has more than one pane group or a pane is focused full-screen, so the no-topbar posture
 *  (spec amendment §A1) is unchanged for anyone not using groups. Layout presets stay in the command
 *  palette. Exported for the app-shell tests. */
export function Main() {
  const layout = useApp((s) => s.layout);
  const items = useApp((s) => s.items);
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
  const zoomedLeafId = useApp((s) => s.groups?.groups.find((g) => g.id === s.groups!.activeGroupId)?.zoomedLeafId ?? null);
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
  if (booted && spaces.length === 0) return <><ErrorBar /><Onboarding /></>;
  if (!spaceId) return <><ErrorBar /><div className="pane-placeholder muted">Create a space with the + in the sidebar.</div></>;
  return (
    <>
      <ErrorBar />
      <GroupBar />
      <PaneHost layout={layout ?? emptyLayout()} items={items} focusedLeafId={focusedLeafId}
        zoomedLeafId={zoomedLeafId}
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
    </>
  );
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
    /* A space's scripts changed — from this window's Scripts panel or another's. Re-read rather than
       patch: `spaceScripts` is what `ownsScriptCommand` consults synchronously on a keystroke, and a
       stale copy is a bound key that runs a script the user just deleted. */
    const offSc = rpc().on("scripts.changed", ({ spaceId }) => {
      const st = store.getState();
      if (spaceId === st.activeSpaceId) st.run(() => st.refreshScripts(spaceId));
    });
    const offI = rpc().on("items.changed", ({ spaceId }) => {
      const st = store.getState();
      if (spaceId === st.activeSpaceId) { st.run(() => st.refreshItems()); st.run(() => st.refreshSessions()); }
    });
    const offV = rpc().on("environments.changed", ({ spaceId }) => {
      const st = store.getState();
      if (spaceId === st.activeSpaceId) st.run(() => st.refreshEnvironments());
    });
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
    // A space's memory document or AGENTS.md changed. Same held-only rule as skills.
    const offMem = rpc().on("memory.changed", ({ spaceId }) => {
      const st = store.getState();
      if (st.spaceMemory[spaceId]) st.run(() => st.refreshMemory(spaceId));
    });
    // An agent opened a browser pane (Plan 11 W3): bring it into the layout — the whole point of the
    // architecture is that the user WATCHES agent-driven browsing, and the native view only exists
    // once the pane mounts. Other spaces just gain the sidebar item via items.changed.
    const offB = rpc().on("browser.agentOpened", ({ spaceId, itemId }) => {
      const st = store.getState();
      if (spaceId === st.activeSpaceId) st.run(async () => { await st.refreshItems(); await st.openItemBeside(itemId); });
    });
    // A session delegated a browsing goal to a browser-agent session (Plan 11 W5): same idiom — the
    // child is a real session, and the point of it being one is that the user watches its whole
    // trace, so it comes into the layout the moment it exists. Other spaces gain the sidebar item
    // via items.changed as usual.
    // A file was surfaced in the documents pane (Plan 22) — by the user, or by an agent's `docs_open`.
    // Same idiom as the browser and session openings: into the layout if this is the active space,
    // and quietly, so a guide an agent just wrote appears beside the session without stealing focus.
    const offDO = rpc().on("documents.openRequested", (p) => { const st = store.getState(); st.run(() => st.applyDocumentOpenRequested(p)); });
    const offSA = rpc().on("session.agentOpened", ({ spaceId, itemId }) => {
      const st = store.getState();
      if (spaceId === st.activeSpaceId) st.run(async () => { await st.refreshItems(); await st.openItemBeside(itemId); });
    });
    // W4's watching feed: settled actions into the pane chrome's ticker, in-flight acts onto the
    // driving dot. Applied for every space (like session.status) — the maps are cheap and a switch
    // back should find the ticker already truthful.
    const offBA = rpc().on("browser.action", (p) => store.getState().applyBrowserAction(p));
    const offBD = rpc().on("browser.driving", (p) => store.getState().applyBrowserDriving(p));
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
    const offMS = rpc().on("mcp.serverStatus", (payload) => store.getState().applyMcpServerStatus(payload));
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
      offS(); offSc(); offI(); offV(); offW(); offSh(); offRun(); offSched(); offP(); offK(); offTh(); offFo(); offMem(); offB(); offDO(); offSA(); offBA(); offBD(); offMach(); offSim(); offGoal(); offMimg(); offE(); offT(); offQ(); offPL(); offN(); offDN?.(); offR(); offDel(); offM(); offMS(); offMC(); offCO(); offCD(); offC();
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
      <AppShell />
      <ConnectionBanner />
      {/* App-level pages, over the workspace and never inside it. Before the sheets so a sheet opened
          from a page still lands on top of it. */}
      <PageOverlay />
      <SheetHost />
      {/* Over everything and outside the layout: it takes no pane, so it belongs to the window
          rather than to any one space's arrangement of it. */}
      <QuickChat />
      <CommandPalette />
      <SpaceOverview />
    </StoreContext.Provider>
  );
}
