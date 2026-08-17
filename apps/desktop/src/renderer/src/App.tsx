import { useEffect, useMemo } from "react";
import { Sidebar } from "./components/Sidebar";
import { StoreContext, createAppStore, liveApi } from "./state/store";
import { rpc } from "./rpc/client";

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
      <div className="app"><Sidebar /><main className="main">{/* PaneHost in Task 13 */}</main></div>
    </StoreContext.Provider>
  );
}
