import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { findSidePane, type Layout } from "@realm/contracts";
import { PaneHost } from "./PaneHost";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";
import { setBrowserBridgesForTests } from "../panes/browser/browser-client";
import { fakeBrowserBridges } from "../panes/browser/browser-bridges.test-fakes";

/**
 * A side pane's tab strip, as the user meets it: the tabs in the bar where a title goes, a click to
 * bring one forward, a drag to reorder or pull one out, and a close that follows the bar's own rule.
 */

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  setBrowserBridgesForTests(fakeBrowserBridges());
});
afterEach(() => { cleanup(); setBrowserBridgesForTests(null); vi.unstubAllGlobals(); });

const ITEMS = [
  item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }),
  item("i-br", "s1", { kind: "browser", refId: "br", title: "Delta careers" }),
  item("i-kid", "s1", { kind: "session", refId: "kid", title: "Agent: apply" }),
];

/** The lead with a side pane holding a browser and a previewed child, the browser showing. */
async function mount() {
  const api = fakeApi({ items: { s1: [...ITEMS] }, sessions: [session("lead", "s1"), session("kid", "s1")] });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  await store.getState().openInSidePane("lead", "i-br");
  await store.getState().openInSidePane("lead", "i-kid");
  await store.getState().openItem("i-br", findSidePane(store.getState().layout!, "i-lead")!.id);
  const host = (layout: Layout) => (
    <StoreContext.Provider value={store}>
      <PaneHost layout={layout} items={store.getState().items} focusedLeafId={store.getState().focusedLeafId}
        onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />
    </StoreContext.Provider>
  );
  const r = render(host(store.getState().layout!));
  const rerender = () => r.rerender(host(store.getState().layout!));
  return { api, store, rerender };
}
const side = (store: Awaited<ReturnType<typeof mount>>["store"]) => findSidePane(store.getState().layout!, "i-lead")!;
const strip = () => within(screen.getByRole("tablist", { name: "Tabs" }));

describe("a side pane's tab strip", () => {
  it("names every tab in the bar, the one showing selected", async () => {
    await mount();
    expect(strip().getAllByRole("tab").map((t) => t.textContent)).toEqual(["Delta careers", "Agent: apply"]);
    expect(strip().getByRole("tab", { name: "Delta careers" })).toHaveAttribute("aria-selected", "true");
    // The strip IS the title: no second title button naming the tab on screen beside it.
    expect(screen.queryByRole("button", { name: "Rename Delta careers" })).toBeNull();
  });

  it("brings a tab forward on click", async () => {
    const { store } = await mount();
    fireEvent.click(strip().getByRole("tab", { name: "Agent: apply" }));
    await waitFor(() => expect(side(store).itemId).toBe("i-kid"));
  });

  it("closes a session's tab out of the layout and keeps the session", async () => {
    const { store, api } = await mount();
    fireEvent.click(strip().getByRole("button", { name: "Close Agent: apply" }));
    await waitFor(() => expect(side(store).tabs).toEqual(["i-br"]));
    expect(api.calls.some((c) => c.startsWith("deleteItem"))).toBe(false);
  });

  it("deletes a browser's tab — two-step, since a live page is under it", async () => {
    const { api } = await mount();
    fireEvent.click(strip().getByRole("button", { name: "Delete Delta careers" }));
    // THE MUTANT: delete on the first click. A stray click on a tab costs the page an agent is driving.
    expect(api.calls.some((c) => c.startsWith("deleteItem"))).toBe(false);
    fireEvent.click(strip().getByRole("button", { name: "Really delete Delta careers?" }));
    await waitFor(() => expect(api.calls).toContain("deleteItem:i-br"));
  });

  it("reorders a tab dropped on another", async () => {
    const { store } = await mount();
    const target = strip().getByRole("tab", { name: "Delta careers" }).parentElement!;
    const dataTransfer = { types: ["application/x-realm-item"], getData: () => "i-kid", setData: () => {} };
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(side(store).tabs).toEqual(["i-kid", "i-br"]));
  });

  it("starts each tab's drag carrying its item, so a pane edge can take it out of the strip", async () => {
    await mount();
    const setData = vi.fn();
    fireEvent.dragStart(strip().getByRole("tab", { name: "Agent: apply" }), { dataTransfer: { types: [], setData, effectAllowed: "" } });
    expect(setData).toHaveBeenCalledWith("application/x-realm-item", "i-kid");
  });

  it("brings a tab behind another forward when its sidebar row is clicked", async () => {
    // THE MUTANT: "go there" focuses the side pane and leaves the browser showing — the click lands
    // and the thing asked for is not on screen.
    const { store } = await mount();
    await store.getState().openItem("i-kid");
    expect(side(store).itemId).toBe("i-kid");
    expect(store.getState().focusedLeafId).toBe(side(store).id);
  });
});
