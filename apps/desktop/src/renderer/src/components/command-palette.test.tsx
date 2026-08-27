import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, renderHook, act } from "@testing-library/react";
import { CommandPalette, usePaletteHotkey } from "./CommandPalette";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi } from "../state/store.test-fakes";

async function mount() {
  const api = fakeApi(); const store = createAppStore(api); await store.getState().boot(); store.setState({ paletteOpen: true });
  render(<StoreContext.Provider value={store}><CommandPalette /></StoreContext.Provider>);
  return { store, api };
}

describe("CommandPalette", () => {
  it("filters spaces and items and runs actions", async () => {
    const { store } = await mount();
    const input = screen.getByRole("combobox"); fireEvent.change(input, { target: { value: "home" } });
    expect(screen.getByRole("option", { name: /Homework/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Versed/ })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("lists the active space's items as Open …, arrows move the selection, Escape closes", async () => {
    const { store } = await mount();
    const input = screen.getByRole("combobox");
    expect(screen.getByRole("option", { name: /Open Terminal/ })).toBeInTheDocument();
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" }); fireEvent.keyDown(input, { key: "ArrowUp" }); // clamps at 0
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("New terminal action creates a terminal; theme actions set the pref; New session opens the sheet", async () => {
    const { store } = await mount();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "new terminal" } }); fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.getState().items).toHaveLength(2));
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "theme: dark" } }); fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(store.getState().themePref).toBe("dark"));
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "new session" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(store.getState().sheet).toEqual({ kind: "new-session" });
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("lists all five layout presets (moved here from the retired topbar LayoutMenu)", async () => {
    await mount();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "layout:" } });
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual([
      "Layout: 1-uplayout",
      "Layout: 2 columnslayout",
      "Layout: 3 columnslayout",
      "Layout: 2×2 gridlayout",
      "Layout: 3×3 gridlayout",
    ]);
  });

  it("picking a preset applies exactly that preset: 'Layout: 3 columns' rebuilds the layout as a 3-wide row split", async () => {
    const { store } = await mount();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "layout: 3 col" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Shape-level assertion so a wrong preset id dies: two-col → 2 children, grid-2x2 → col-of-rows, one → leaf.
    await waitFor(() => {
      const l = store.getState().layout;
      expect(l?.type === "split" && l.dir === "row" && l.children.length).toBe(3);
    });
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("⌘K toggles the palette", () => {
    const store = createAppStore(fakeApi());
    renderHook(() => usePaletteHotkey(store));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(store.getState().paletteOpen).toBe(true);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(store.getState().paletteOpen).toBe(false);
    fireEvent.keyDown(window, { key: "k" });
    expect(store.getState().paletteOpen).toBe(false);
    store.getState().openSheet({ kind: "new-space" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(store.getState().paletteOpen).toBe(false); // ignored while a sheet is open
  });
});
