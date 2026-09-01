import { useEffect, useMemo } from "react";
import { Sidebar } from "./components/sidebar/Sidebar";
import { NewSpaceSheet } from "./components/sidebar/NewSpaceSheet";
import { RemoveWorktreeSheet } from "./components/RemoveWorktreeSheet";
import { CheckpointsSheet } from "./components/CheckpointsSheet";
import { ActivitySheet } from "./components/ActivitySheet";
import { CommandPalette, usePaletteHotkey } from "./components/CommandPalette";
import { PaneHost } from "./components/PaneHost";
import { Onboarding } from "./components/Onboarding";
import { StoreContext, createAppStore, useApp } from "./state/store";
import { liveApi } from "./state/live-api";
import { rpc } from "./rpc/client";
import { emptyLayout } from "@realm/contracts";
import { useApplyTheme } from "./theme/useTheme";
import { useGlobalHotkeys } from "./hotkeys";
import "./panes";

/** Writes the active space's palette to :root; lives under the store provider so it can read state. */
function ThemeBridge() {
  const color = useApp((s) => s.activeSpace()?.color ?? null);
  const pref = useApp((s) => s.themePref);
  useApplyTheme(color, pref);
  return null;
}

/** Slim persistent banner while the RPC socket is down; Retry skips the backoff wait. */
function ConnectionBanner() {
  const state = useApp((s) => s.connectionState);
  if (state === "connected") return null;
  return (
    <div className="conn-banner" role="status">
      <span>Connection lost — reconnecting…</span>
      <button onClick={() => rpc().retryNow()}>Retry</button>
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
  return null;
}

/** Full-bleed PaneHost for the active space (no topbar — spec amendment §A1; layout presets live
 *  in the command palette). Exported for the app-shell tests. */
export function Main() {
  const layout = useApp((s) => s.layout);
  const items = useApp((s) => s.items);
  const spaceId = useApp((s) => s.activeSpaceId);
  const booted = useApp((s) => s.booted);
  const spaces = useApp((s) => s.spaces);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const focusLeaf = useApp((s) => s.focusLeaf);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const splitFocused = useApp((s) => s.splitFocused);
  const openItemAt = useApp((s) => s.openItemAt);
  const resizeSplit = useApp((s) => s.resizeSplit);
  const run = useApp((s) => s.run);
  // First run (W4): no spaces at all — the onboarding sheet, not a sentence pointing at a "+". It is
  // gated on `booted` because an unbooted store also has zero spaces, and on the space COUNT rather than
  // `activeSpaceId`, so it can never come back for someone who already has spaces.
  if (booted && spaces.length === 0) return <><ErrorBar /><Onboarding /></>;
  if (!spaceId) return <><ErrorBar /><div className="pane-placeholder muted">Create a space with the + in the sidebar.</div></>;
  return (
    <>
      <ErrorBar />
      <PaneHost layout={layout ?? emptyLayout()} items={items} focusedLeafId={focusedLeafId}
        onFocus={focusLeaf}
        onClose={(id) => run(() => closeFromLayout(id))}
        // The split button targets its own leaf: focus it synchronously, then split reads the fresh focus.
        onSplit={(leafId, dir) => { focusLeaf(leafId); run(() => splitFocused(dir)); }}
        onResize={resizeSplit}
        onDropItem={(id, leafId, edge) => run(() => openItemAt(id, leafId, edge))} />
    </>
  );
}

export function App() {
  const store = useMemo(() => createAppStore(liveApi()), []);
  usePaletteHotkey(store);
  useGlobalHotkeys(store);
  useEffect(() => {
    const s = store.getState();
    s.run(() => s.boot());
    const offS = rpc().on("spaces.changed", () => store.getState().run(() => store.getState().refreshSpaces()));
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
    const offSA = rpc().on("session.agentOpened", ({ spaceId, itemId }) => {
      const st = store.getState();
      if (spaceId === st.activeSpaceId) st.run(async () => { await st.refreshItems(); await st.openItemBeside(itemId); });
    });
    // W4's watching feed: settled actions into the pane chrome's ticker, in-flight acts onto the
    // driving dot. Applied for every space (like session.status) — the maps are cheap and a switch
    // back should find the ticker already truthful.
    const offBA = rpc().on("browser.action", (p) => store.getState().applyBrowserAction(p));
    const offBD = rpc().on("browser.driving", (p) => store.getState().applyBrowserDriving(p));
    const offE = rpc().on("session.event", (ev) => store.getState().applySessionEvent(ev));
    const offT = rpc().on("session.status", ({ sessionId, status }) => store.getState().applySessionStatus(sessionId, status));
    // The feed (Plan 12 W5): every change carries the server's unread count for the sidebar pill, and
    // a surfaced row for the focused-pane auto-read — see applyNotificationsChanged.
    const offN = rpc().on("notifications.changed", (p) => store.getState().applyNotificationsChanged(p));
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
      offS(); offI(); offV(); offW(); offSh(); offP(); offK(); offMem(); offB(); offSA(); offBA(); offBD(); offE(); offT(); offN(); offM(); offMS(); offMC(); offC();
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("dragover", swallowDrop);
      window.removeEventListener("drop", swallowDrop);
    };
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <ThemeBridge />
      <div className="app"><Sidebar /><main className="main"><Main /></main></div>
      <ConnectionBanner />
      <SheetHost />
      <CommandPalette />
    </StoreContext.Provider>
  );
}
