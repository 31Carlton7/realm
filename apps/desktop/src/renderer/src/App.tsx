import { useEffect, useMemo } from "react";
import { Sidebar } from "./components/Sidebar";
import { PaneHost } from "./components/PaneHost";
import { LayoutMenu } from "./components/LayoutMenu";
import { StoreContext, createAppStore, liveApi, useApp } from "./state/store";
import { rpc } from "./rpc/client";
import { emptyLayout } from "@realm/contracts";

function Main() {
  const layout = useApp((s) => s.layout);
  const items = useApp((s) => s.items);
  const spaceId = useApp((s) => s.activeSpaceId);
  const activateTab = useApp((s) => s.activateTab);
  const closeItem = useApp((s) => s.closeItem);
  const split = useApp((s) => s.splitWithNewTerminal);
  const applyPreset = useApp((s) => s.applyPreset);
  const setLayoutLocal = useApp((s) => s.setLayoutLocal);
  const persistLayout = useApp((s) => s.persistLayout);
  if (!spaceId) return <div className="pane-placeholder muted">Create or pick a space.</div>;
  return (
    <>
      <div className="topbar"><LayoutMenu onPick={(p) => void applyPreset(p)} /></div>
      <PaneHost layout={layout ?? emptyLayout()} items={items}
        onActivate={(id) => void activateTab(id)} onClose={(id) => void closeItem(id)}
        onSplit={(leafId, dir) => void split(leafId, dir)}
        onResize={(splitId, sizes) => { const l = layout; if (!l) return; setLayoutLocal(updateSizes(l, splitId, sizes)); void persistLayout(); }} />
    </>
  );
}
function updateSizes(l: import("@realm/contracts").Layout, splitId: string, sizes: number[]): import("@realm/contracts").Layout {
  if (l.type === "leaf") return l;
  return l.id === splitId ? { ...l, sizes } : { ...l, children: l.children.map((c) => updateSizes(c, splitId, sizes)) };
}

export function App() {
  const store = useMemo(() => createAppStore(liveApi()), []);
  useEffect(() => {
    void store.getState().boot();
    const offS = rpc().on("spaces.changed", () => void store.getState().refreshSpaces());
    const offI = rpc().on("items.changed", ({ spaceId }) => { if (spaceId === store.getState().activeSpaceId) void store.getState().refreshItems(); });
    return () => { offS(); offI(); };
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <div className="app"><Sidebar /><main className="main"><Main /></main></div>
    </StoreContext.Provider>
  );
}
