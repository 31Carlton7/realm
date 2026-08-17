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

  it("New terminal action creates a terminal; theme actions set the pref; disabled entries do nothing", async () => {
    const { store } = await mount();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "new terminal" } }); fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.getState().items).toHaveLength(2));
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "theme: dark" } }); fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(store.getState().themePref).toBe("dark"));
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "new session" } });
    expect(screen.getByRole("option", { name: /New session/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(store.getState().paletteOpen).toBe(true); // disabled entry: stays open
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
