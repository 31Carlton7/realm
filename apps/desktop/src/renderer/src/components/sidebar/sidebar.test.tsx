import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, space } from "../../state/store.test-fakes";

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

  it("session items show a status dot that follows sessionStatus (pulsing state exposed via data-status)", async () => {
    const { store } = await mount(fakeApi({ items: { s1: [item("i1", "s1", { title: "Terminal" }), item("i2", "s1", { kind: "session", refId: "se1", title: "Fix the build" })] } }));
    const row = () => screen.getByRole("button", { name: "Fix the build" });
    expect(row().querySelector(".status-dot")).toBeNull(); // no status known yet
    act(() => store.getState().applySessionStatus("se1", "waiting_permission"));
    expect(row().querySelector(".status-dot")).toHaveAttribute("data-status", "waiting_permission");
    act(() => store.getState().applySessionStatus("se1", "idle"));
    expect(row().querySelector(".status-dot")).toHaveAttribute("data-status", "idle");
    expect(screen.getByRole("button", { name: "Terminal" }).querySelector(".status-dot")).toBeNull();
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

  it("New… menu creates a terminal; Session… opens the sheet; browser entry is disabled", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "New item" }));
    expect(screen.getByRole("menuitem", { name: /Browser tab/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /Session/ }));
    expect(store.getState().sheet).toEqual({ kind: "new-session" });
    fireEvent.click(screen.getByRole("button", { name: "New item" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await waitFor(() => expect(store.getState().items).toHaveLength(2));
  });

  it("menus render in a portal with fixed positioning so ancestor overflow can't clip them (regression: the swiper's overflow:clip was hiding the New… menu)", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "New item" }));
    const menu = screen.getByRole("menu", { name: "New item" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
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

  it("dragging the first strip icon onto the last moves it to the end ([A,B,C] → [B,C,A])", async () => {
    const api = fakeApi({ spaces: [space("a", "p1", "A"), space("b", "p1", "B"), space("c", "p1", "C")], items: {} });
    const { store } = await mount(api);
    const dt = { effectAllowed: "", setData: () => {}, getData: () => "a" };
    fireEvent.dragStart(screen.getByRole("button", { name: /switch to space A$/i }), { dataTransfer: dt });
    fireEvent.drop(screen.getByRole("button", { name: /switch to space C$/i }), { dataTransfer: dt });
    await waitFor(() => expect(store.getState().spaces.map((s) => s.id)).toEqual(["b", "c", "a"]));
    // and back to the front (leftward drag lands before the target)
    fireEvent.dragStart(screen.getByRole("button", { name: /switch to space A$/i }), { dataTransfer: dt });
    fireEvent.drop(screen.getByRole("button", { name: /switch to space B$/i }), { dataTransfer: dt });
    await waitFor(() => expect(store.getState().spaces.map((s) => s.id)).toEqual(["a", "b", "c"]));
  });

  it("inactive swiper pages are inert (their controls are not reachable)", async () => {
    const { container } = await mount();
    const pages = container.querySelectorAll<HTMLElement>(".space-page");
    expect(pages).toHaveLength(2);
    expect(pages[0]!.hasAttribute("inert")).toBe(false);
    expect(pages[1]!.hasAttribute("inert")).toBe(true);
    expect(pages[1]!.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(pages[1]!.hasAttribute("inert")).toBe(false));
    expect(pages[0]!.hasAttribute("inert")).toBe(true);
  });

  it("the profile pill opens the space settings sheet and + opens the new-space sheet", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(store.getState().sheet).toEqual({ kind: "space-settings", spaceId: "s1" });
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    expect(store.getState().sheet).toEqual({ kind: "new-space" });
  });
});
