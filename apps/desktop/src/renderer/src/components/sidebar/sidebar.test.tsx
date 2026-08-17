import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

async function mount(api = fakeApi()) {
  const store = createAppStore(api); await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("Arc sidebar", () => {
  it("shows only the active space's items, the space strip with all spaces, and switches on strip click", async () => {
    const { store } = await mount();
    expect(screen.getByRole("heading", { name: /Versed/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Homework/ })).not.toBeInTheDocument(); // other pages are aria-hidden
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /switch to space/i })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /switch to space Versed/i })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Homework/ })).toBeInTheDocument());
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
  });

  it("pinned items render as tiles, unpinned in the list", async () => {
    await mount(fakeApi({ items: { s1: [item("i1", "s1", { pinned: true, title: "GitHub" }), item("i2", "s1", { title: "Terminal" })] } }));
    expect(screen.getByRole("button", { name: /GitHub/ })).toHaveAttribute("data-tile", "true");
    expect(screen.getByRole("button", { name: "Terminal" })).not.toHaveAttribute("data-tile");
  });

  it("two-finger horizontal wheel on the sidebar switches spaces; vertical wheel does not", async () => {
    const { store, container } = await mount();
    const swiper = container.querySelector("[data-swiper]")!;
    fireEvent.wheel(swiper, { deltaX: 0, deltaY: 120 });
    fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 }); fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("right-click on an item offers Pin, which moves it to the pinned grid; close removes it", async () => {
    const { store, api } = await mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Terminal/ })).toHaveAttribute("data-tile", "true"));
    expect(store.getState().items[0]?.pinned).toBe(true);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Terminal/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    await waitFor(() => expect(store.getState().items).toHaveLength(0));
    expect(api.calls).toContain("deleteItem:i1");
  });

  it("rename via the context menu commits on Enter", async () => {
    const { store } = await mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: /Rename Terminal/ });
    fireEvent.change(input, { target: { value: "Build" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.getState().items[0]?.title).toBe("Build"));
    expect(screen.getByRole("button", { name: "Build" })).toBeInTheDocument();
  });

  it("New… menu creates a terminal; session and browser entries are disabled", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "New item" }));
    expect(screen.getByRole("menuitem", { name: /Session/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Browser tab/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await waitFor(() => expect(store.getState().items).toHaveLength(2));
  });

  it("dragging a strip icon onto another reorders spaces", async () => {
    const { store, api } = await mount();
    const versed = screen.getByRole("button", { name: /switch to space Versed/i });
    const homework = screen.getByRole("button", { name: /switch to space Homework/i });
    const dt = { effectAllowed: "", setData: () => {}, getData: () => "s2" };
    fireEvent.dragStart(homework, { dataTransfer: dt });
    fireEvent.dragOver(versed, { dataTransfer: dt });
    fireEvent.drop(versed, { dataTransfer: dt });
    await waitFor(() => expect(store.getState().spaces.map((s) => s.id)).toEqual(["s2", "s1"]));
    expect(api.calls).toContain("reorderSpaces:s2,s1");
  });

  it("the profile pill opens the space settings sheet and + opens the new-space sheet", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(store.getState().sheet).toEqual({ kind: "space-settings", spaceId: "s1" });
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    expect(store.getState().sheet).toEqual({ kind: "new-space" });
  });
});
