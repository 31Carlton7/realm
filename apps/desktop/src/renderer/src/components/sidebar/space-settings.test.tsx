import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SpaceSettingsSheet } from "./SpaceSettingsSheet";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, session } from "../../state/store.test-fakes";
import type { Environment } from "@realm/contracts";

async function mount() {
  const api = fakeApi(); const store = createAppStore(api); await store.getState().boot();
  store.getState().openSheet({ kind: "space-settings", spaceId: "s1" });
  render(<StoreContext.Provider value={store}><SpaceSettingsSheet spaceId="s1" /></StoreContext.Provider>);
  return { store, api };
}

describe("SpaceSettingsSheet", () => {
  it("renames on blur, picks icon/color/profile, custom hex only when valid", async () => {
    const { store } = await mount();
    const name = screen.getByRole("textbox", { name: "Space name" });
    fireEvent.change(name, { target: { value: "Versed 2" } }); fireEvent.blur(name);
    await waitFor(() => expect(store.getState().activeSpace()?.name).toBe("Versed 2"));
    fireEvent.click(screen.getByRole("radio", { name: "Icon cap" }));
    await waitFor(() => expect(store.getState().activeSpace()?.icon).toBe("cap"));
    fireEvent.click(screen.getByRole("radio", { name: "Color #3ddc97" }));
    await waitFor(() => expect(store.getState().activeSpace()?.color).toBe("#3ddc97"));
    const hex = screen.getByRole("textbox", { name: "Custom color" });
    fireEvent.change(hex, { target: { value: "#12" } });
    expect(store.getState().activeSpace()?.color).toBe("#3ddc97");
    fireEvent.change(hex, { target: { value: "#123ABC" } });
    await waitFor(() => expect(store.getState().activeSpace()?.color).toBe("#123abc"));
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "p2" } });
    await waitFor(() => expect(store.getState().activeSpace()?.profileId).toBe("p2"));
  });

  it("delete requires confirmation, then removes the space and closes the sheet", async () => {
    const { store, api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: /Delete space/ }));
    expect(api.calls.some((c) => c.startsWith("deleteSpace"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(store.getState().spaces.map((s) => s.id)).toEqual(["s2"]));
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(store.getState().sheet).toBeNull();
  });

  it("Escape closes the sheet", async () => {
    const { store } = await mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(store.getState().sheet).toBeNull();
  });
});

/** W1 split the checkout out of the session and W2 made worktrees; this list is where that split is
 *  finally visible, and the only route to removing a worktree after its session is gone (W3). */
describe("the space's checkouts", () => {
  const envs: Environment[] = [
    { id: "envP", spaceId: "s1", path: "/tmp/versed", branch: "main", kind: "primary", portBlockStart: 41000, createdAt: 0, updatedAt: 0 },
    { id: "envW", spaceId: "s1", path: "/tmp/worktrees/s1/fix-login", branch: "realm/fix-login", kind: "worktree", portBlockStart: 41020, createdAt: 0, updatedAt: 0 },
  ];

  async function openSettings(extra: Partial<Parameters<typeof fakeApi>[0]> = {}) {
    const api = fakeApi({
      environments: { s1: envs },
      sessions: [session("se1", "s1", { environmentId: "envW" }), session("se2", "s1", { environmentId: "envW" })],
      worktreeStatus: { envW: { environmentId: "envW", path: "/tmp/worktrees/s1/fix-login", branch: "realm/fix-login", present: true, dirtyFiles: 0, unpushedCommits: 0, removable: true, blockedBy: null } },
      ...extra,
    });
    const store = createAppStore(api); await store.getState().boot();
    const r = render(<StoreContext.Provider value={store}><SpaceSettingsSheet spaceId="s1" /></StoreContext.Provider>);
    return { api, store, ...r };
  }

  it("names each checkout, its kind, its reserved port range and who is in it", async () => {
    await openSettings();
    const worktree = screen.getByText("realm/fix-login").closest(".env-row") as HTMLElement;
    expect(within(worktree).getByText("Worktree")).toBeInTheDocument();
    expect(within(worktree).getByText("/tmp/worktrees/s1/fix-login")).toBeInTheDocument();
    // A RANGE Realm holds — never a claim about what is listening on it.
    expect(within(worktree).getByText("ports 41020–41029 reserved")).toBeInTheDocument();
    expect(within(worktree).getByText("2 sessions")).toBeInTheDocument();
    const primary = screen.getByText("main").closest(".env-row") as HTMLElement;
    expect(within(primary).getByText("Space folder")).toBeInTheDocument();
    expect(within(primary).getByText("no sessions")).toBeInTheDocument();
  });

  it("offers removal only for the worktree, never for the space's own folder", async () => {
    const { api, store } = await openSettings();
    const primary = screen.getByText("main").closest(".env-row") as HTMLElement;
    expect(within(primary).queryByRole("button", { name: "Remove…" })).toBeNull();
    const worktree = screen.getByText("realm/fix-login").closest(".env-row") as HTMLElement;
    fireEvent.click(within(worktree).getByRole("button", { name: "Remove…" }));
    // The button opens the confirm (App renders it), having first read what removal would cost.
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "remove-worktree", environmentId: "envW" }));
    expect(api.calls).toContain("worktreeStatus:envW");
  });

  it("says a brand-new space has no checkout on record rather than rendering an empty list", async () => {
    // environments.list is empty until a space actually runs something — the primary row is lazy.
    await openSettings({ environments: {} });
    expect(screen.getByText(/has not run anything yet/)).toBeInTheDocument();
  });
});
