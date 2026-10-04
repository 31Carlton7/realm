import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const listeners = new Map<string, () => void>();
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: (event: string, cb: () => void) => { listeners.set(event, cb); return () => listeners.delete(event); },
    call: async () => { throw new Error("no rpc in this test"); },
  }),
}));

import { ProfileWindowBridge } from "./ProfileWindowBridge";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, space } from "../../state/store.test-fakes";

afterEach(() => { vi.unstubAllGlobals(); listeners.clear(); });

describe("ProfileWindowBridge", () => {
  it("tells main which profile the window shows, and again whenever it changes", async () => {
    /* THE mutant: report only at mount. A first window switched from Personal to Work would still be
       Personal's to main, and "Open Personal in a new window" would bring this window — now showing
       Work — forward instead of opening Personal. */
    const setProfile = vi.fn();
    vi.stubGlobal("realm", { ...window.realm, windows: { openProfile: vi.fn(), focusProfile: vi.fn(), setProfile } });
    const store = createAppStore(fakeApi({ spaces: [space("s1", "p1", "Versed"), space("s2", "p2", "Homework")] }));
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><ProfileWindowBridge /></StoreContext.Provider>);
    expect(setProfile).toHaveBeenLastCalledWith("p1");
    await act(async () => { await store.getState().selectSpace("s2"); });
    expect(setProfile).toHaveBeenLastCalledWith("p2");
  });

  it("re-reads profiles when the server says they changed — another window made one", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><ProfileWindowBridge /></StoreContext.Provider>);
    // A new list, not the old one pushed to: the fake hands the store its own array, and a push would
    // show up without anything having been read again.
    api.data.profiles = [...api.data.profiles, profile("p7", "Clients")];
    expect(store.getState().profiles.map((p) => p.name)).not.toContain("Clients");
    const fire = listeners.get("profiles.changed");
    expect(fire).toBeDefined();
    await act(async () => { fire!(); await Promise.resolve(); await Promise.resolve(); });
    expect(store.getState().profiles.map((p) => p.name)).toContain("Clients");
  });
});
