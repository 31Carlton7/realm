import { useEffect, useMemo } from "react";
import { Sidebar } from "./components/Sidebar";
import { PaneHost } from "./components/PaneHost";
import { LayoutMenu } from "./components/LayoutMenu";
import { StoreContext, createAppStore, useApp } from "./state/store";
import { liveApi } from "./state/live-api";
import { rpc } from "./rpc/client";
import { emptyLayout } from "@realm/contracts";
import "./panes";

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
  if (!spaceId) return <><ErrorBar /><div className="pane-placeholder muted">Create or pick a space.</div></>;
  return (
    <>
      <div className="topbar"><LayoutMenu onPick={(p) => run(() => applyPreset(p))} /></div>
      <ErrorBar />
      <PaneHost layout={layout ?? emptyLayout()} items={items}
        onActivate={(id) => run(() => activateTab(id))} onClose={(id) => run(() => closeItem(id))}
        onSplit={(leafId, dir) => run(() => split(leafId, dir))}
        onResize={resizeSplit} />
    </>
  );
}

export function App() {
  const store = useMemo(() => createAppStore(liveApi()), []);
  useEffect(() => {
    const s = store.getState();
    s.run(() => s.boot());
    const offS = rpc().on("spaces.changed", () => store.getState().run(() => store.getState().refreshSpaces()));
    const offI = rpc().on("items.changed", ({ spaceId }) => {
      const st = store.getState();
      if (spaceId === st.activeSpaceId) st.run(() => st.refreshItems());
    });
    return () => { offS(); offI(); };
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <div className="app"><Sidebar /><main className="main"><Main /></main></div>
    </StoreContext.Provider>
  );
}
