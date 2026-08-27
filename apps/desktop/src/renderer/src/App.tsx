import { useEffect, useMemo } from "react";
import type { StoreApi } from "zustand";
import { Sidebar } from "./components/sidebar/Sidebar";
import { NewSpaceSheet } from "./components/sidebar/NewSpaceSheet";
import { SpaceSettingsSheet } from "./components/sidebar/SpaceSettingsSheet";
import { NewSessionSheet } from "./panes/session/NewSessionSheet";
import { CommandPalette, usePaletteHotkey } from "./components/CommandPalette";
import { Icon } from "@realm/ui";
import { PaneHost } from "./components/PaneHost";
import { LayoutMenu } from "./components/LayoutMenu";
import { StoreContext, createAppStore, useApp, type AppState } from "./state/store";
import { liveApi } from "./state/live-api";
import { rpc } from "./rpc/client";
import { emptyLayout, itemIdOfLeaf } from "@realm/contracts";
import { useApplyTheme } from "./theme/useTheme";
import "./panes";

/** ⌘\ splits the focused leaf to the right. Bind once at the app root. */
export function useSplitHotkey(store: StoreApi<AppState>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "\\") {
        e.preventDefault();
        const s = store.getState();
        if (s.sheet || s.paletteOpen) return; // a modal sheet or the command palette owns the keyboard
        s.run(() => s.splitFocused("row"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}

/** Writes the active space's palette to :root; lives under the store provider so it can read state. */
function ThemeBridge() {
  const color = useApp((s) => s.activeSpace()?.color ?? null);
  const pref = useApp((s) => s.themePref);
  useApplyTheme(color, pref);
  return null;
}

function ErrorBar() {
  const error = useApp((s) => s.error);
  const clearError = useApp((s) => s.clearError);
  if (!error) return null;
  return (
    <div className="error-bar" role="alert">
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

/** `<space icon> <space name> / <focused item title>` — the item in the focused leaf, if any. */
function Breadcrumb() {
  const space = useApp((s) => s.activeSpace());
  const items = useApp((s) => s.items);
  const layout = useApp((s) => s.layout);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  if (!space) return null;
  const focusedItemId = itemIdOfLeaf(layout, focusedLeafId);
  const item = items.find((i) => i.id === focusedItemId);
  return (
    <div className="breadcrumb" aria-label="Location">
      <Icon name={space.icon} size={14} /><span className="crumb">{space.name}</span>
      {item && <><span className="crumb-sep">/</span><span className="crumb muted">{item.title}</span></>}
    </div>
  );
}

/** Topbar + PaneHost for the active space. Exported for the app-shell tests. */
export function Main() {
  const layout = useApp((s) => s.layout);
  const items = useApp((s) => s.items);
  const spaceId = useApp((s) => s.activeSpaceId);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const focusLeaf = useApp((s) => s.focusLeaf);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const splitFocused = useApp((s) => s.splitFocused);
  const openItemAt = useApp((s) => s.openItemAt);
  const applyPreset = useApp((s) => s.applyPreset);
  const resizeSplit = useApp((s) => s.resizeSplit);
  const run = useApp((s) => s.run);
  if (!spaceId) return <><ErrorBar /><div className="pane-placeholder muted">Create a space with the + in the sidebar.</div></>;
  return (
    <>
      <div className="topbar"><Breadcrumb /><LayoutMenu onPick={(p) => run(() => applyPreset(p))} /></div>
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
  useSplitHotkey(store);
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
    return () => { offS(); offI(); offE(); offT(); };
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <ThemeBridge />
      <div className="app"><Sidebar /><main className="main"><Main /></main></div>
      <SheetHost />
      <CommandPalette />
    </StoreContext.Provider>
  );
}
