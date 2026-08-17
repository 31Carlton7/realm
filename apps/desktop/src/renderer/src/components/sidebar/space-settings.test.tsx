import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SpaceSettingsSheet } from "./SpaceSettingsSheet";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

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
