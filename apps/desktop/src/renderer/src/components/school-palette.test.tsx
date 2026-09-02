import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi } from "../state/store.test-fakes";

async function mount() {
  const api = fakeApi(); const store = createAppStore(api); await store.getState().boot();
  act(() => store.setState({ paletteOpen: true }));
  render(<StoreContext.Provider value={store}><CommandPalette /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("listAllItems"));
  return { store, api };
}

describe("palette — the lecture loop (Plan 22)", () => {
  it("offers the three school actions, each opening its sheet", async () => {
    const { store } = await mount();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "lecture" } });
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(expect.arrayContaining([expect.stringContaining("New lecture…"), expect.stringContaining("Wrap up a lecture…")]));
    fireEvent.click(screen.getByRole("option", { name: /New lecture…/ }));
    expect(store.getState().sheet).toEqual({ kind: "new-lecture" });
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("finds the Plynn import by name", async () => {
    const { store } = await mount();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "plynn" } });
    fireEvent.click(screen.getByRole("option", { name: /Import recording from Plynn…/ }));
    expect(store.getState().sheet).toEqual({ kind: "plynn-import" });
  });
});
