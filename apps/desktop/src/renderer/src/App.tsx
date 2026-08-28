import { useEffect, useMemo } from "react";
import { Sidebar } from "./components/sidebar/Sidebar";
import { NewSpaceSheet } from "./components/sidebar/NewSpaceSheet";
import { SpaceSettingsSheet } from "./components/sidebar/SpaceSettingsSheet";
import { NewSessionSheet } from "./panes/session/NewSessionSheet";
import { CommandPalette, usePaletteHotkey } from "./components/CommandPalette";
import { PaneHost } from "./components/PaneHost";
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
  if (sheet.kind === "new-session") return <NewSessionSheet />;
  return null;
}

/** Full-bleed PaneHost for the active space (no topbar — spec amendment §A1; layout presets live
 *  in the command palette). Exported for the app-shell tests. */
export function Main() {
  const layout = useApp((s) => s.layout);
  const items = useApp((s) => s.items);
  const spaceId = useApp((s) => s.activeSpaceId);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const focusLeaf = useApp((s) => s.focusLeaf);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const splitFocused = useApp((s) => s.splitFocused);
  const openItemAt = useApp((s) => s.openItemAt);
  const resizeSplit = useApp((s) => s.resizeSplit);
  const run = useApp((s) => s.run);
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
    const offE = rpc().on("session.event", (ev) => store.getState().applySessionEvent(ev));
    const offT = rpc().on("session.status", ({ sessionId, status }) => store.getState().applySessionStatus(sessionId, status));
    const offC = rpc().onStatusChange((state) => store.getState().applyConnectionState(state));
    // Quit/reload with a resize inside the persist debounce window would silently lose it (A-M4).
    const onPageHide = () => { store.getState().flushPersist().catch(() => {}); }; // best-effort: socket may be gone at quit
    window.addEventListener("pagehide", onPageHide);
    return () => { offS(); offI(); offE(); offT(); offC(); window.removeEventListener("pagehide", onPageHide); };
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
