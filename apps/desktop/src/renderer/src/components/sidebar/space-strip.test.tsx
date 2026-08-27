import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SpaceStrip } from "./SpaceStrip";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";

async function mount(api = fakeApi()) {
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><SpaceStrip /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("SpaceStrip overflow (A-H2)", () => {
  // jsdom has no layout, so scrolling can't be observed — assert the effect's call instead.
  const scrollSpy = vi.fn();
  beforeEach(() => {
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy;
    scrollSpy.mockClear();
  });

  it("scrolls the active space's button into view on mount and again on every activation", async () => {
    await mount();
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ inline: "nearest", block: "nearest" }));
    expect(scrollSpy.mock.contexts.at(-1)).toBe(screen.getByRole("button", { name: /switch to space Versed/i }));
    scrollSpy.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ inline: "nearest", block: "nearest" }));
    expect(scrollSpy.mock.contexts.at(-1)).toBe(screen.getByRole("button", { name: /switch to space Homework/i }));
  });
});

describe("SpaceStrip settings gear (U-M9)", () => {
  it("opens the space-settings sheet for the active space", async () => {
    const { store } = await mount();
    expect(store.getState().activeSpaceId).toBe("s1");
    const gear = screen.getByRole("button", { name: "Settings" });
    expect(gear).toBeEnabled();
    fireEvent.click(gear);
    expect(store.getState().sheet).toEqual({ kind: "space-settings", spaceId: "s1" });
  });

  it("follows the active space, and is disabled with no space at all", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(store.getState().sheet).toEqual({ kind: "space-settings", spaceId: "s2" });

    const empty = await mount(fakeApi({ spaces: [], items: {} }));
    expect(empty.store.getState().activeSpaceId).toBeNull();
    const gears = screen.getAllByRole("button", { name: "Settings" });
    expect(gears.at(-1)).toBeDisabled();
    fireEvent.click(gears.at(-1)!);
    expect(empty.store.getState().sheet).toBeNull();
  });
});
