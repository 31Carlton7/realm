import { useEffect, useMemo } from "react";
import { Sidebar } from "./components/sidebar/Sidebar";
import { NewSpaceSheet } from "./components/sidebar/NewSpaceSheet";
import { SpaceSettingsSheet } from "./components/sidebar/SpaceSettingsSheet";
import { RemoveWorktreeSheet } from "./components/RemoveWorktreeSheet";
import { CheckpointsSheet } from "./components/CheckpointsSheet";
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
  if (sheet.kind === "space-settings") return <SpaceSettingsSheet spaceId={sheet.spaceId} />;
  if (sheet.kind === "remove-worktree") return <RemoveWorktreeSheet environmentId={sheet.environmentId} />;
  if (sheet.kind === "checkpoints") return <CheckpointsSheet environmentId={sheet.environmentId} sessionId={sheet.sessionId} />;
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
    const offE = rpc().on("session.event", (ev) => store.getState().applySessionEvent(ev));
    const offT = rpc().on("session.status", ({ sessionId, status }) => store.getState().applySessionStatus(sessionId, status));
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
      offS(); offI(); offV(); offW(); offP(); offE(); offT(); offC();
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
