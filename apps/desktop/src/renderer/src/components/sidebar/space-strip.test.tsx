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
