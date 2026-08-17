import { useEffect, useMemo } from "react";
import { Sidebar } from "./components/sidebar/Sidebar";
import { NewSpaceSheet } from "./components/sidebar/NewSpaceSheet";
import { SpaceSettingsSheet } from "./components/sidebar/SpaceSettingsSheet";
import { CommandPalette, usePaletteHotkey } from "./components/CommandPalette";
import { Icon } from "@realm/ui";
import { activeTabIds } from "./components/sidebar/active-tabs";
import { PaneHost } from "./components/PaneHost";
import { LayoutMenu } from "./components/LayoutMenu";
import { StoreContext, createAppStore, useApp } from "./state/store";
import { liveApi } from "./state/live-api";
import { rpc } from "./rpc/client";
import { emptyLayout } from "@realm/contracts";
import { useApplyTheme } from "./theme/useTheme";
import "./panes";

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
  return null;
}

/** `<space icon> <space name> / <active tab title>` — the first active tab found in the layout. */
function Breadcrumb() {
  const space = useApp((s) => s.activeSpace());
  const items = useApp((s) => s.items);
  const layout = useApp((s) => s.layout);
  if (!space) return null;
  const firstActive = [...activeTabIds(layout)][0];
  const tab = items.find((i) => i.id === firstActive);
  return (
    <div className="breadcrumb" aria-label="Location">
      <Icon name={space.icon} size={14} /><span className="crumb">{space.name}</span>
      {tab && <><span className="crumb-sep">/</span><span className="crumb muted">{tab.title}</span></>}
    </div>
  );
}

function Main() {
  const layout = useApp((s) => s.layout);
  const items = useApp((s) => s.items);
  const spaceId = useApp((s) => s.activeSpaceId);
  const activateTab = useApp((s) => s.activateTab);
  const closeItem = useApp((s) => s.closeItem);
  const split = useApp((s) => s.splitWithNewTerminal);
  const applyPreset = useApp((s) => s.applyPreset);
  const resizeSplit = useApp((s) => s.resizeSplit);
  const run = useApp((s) => s.run);
  if (!spaceId) return <div className="content-card"><ErrorBar /><div className="pane-placeholder muted">Create a space with the + in the sidebar.</div></div>;
  return (
    <div className="content-card">
      <div className="card-topbar"><Breadcrumb /><LayoutMenu onPick={(p) => run(() => applyPreset(p))} /></div>
      <ErrorBar />
      <PaneHost layout={layout ?? emptyLayout()} items={items}
        onActivate={(id) => run(() => activateTab(id))} onClose={(id) => run(() => closeItem(id))}
        onSplit={(leafId, dir) => run(() => split(leafId, dir))}
        onResize={resizeSplit} />
    </div>
  );
}

export function App() {
  const store = useMemo(() => createAppStore(liveApi()), []);
  usePaletteHotkey(store);
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
