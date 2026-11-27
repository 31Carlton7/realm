import { describe, expect, it, vi } from "vitest";
import { allItems, findSidePane } from "@realm/contracts";
import { subscribeSelfClosedTabs } from "./App";
import { createAppStore } from "./state/store";
import { fakeApi, item, session } from "./state/store.test-fakes";

/** A browser and the popup it opened, both on screen, and main's "this page closed itself" captured. */
async function popupOpen() {
  const api = fakeApi({ items: { s1: [
    item("i-br", "s1", { kind: "browser", refId: "br", title: "Sign in" }),
    item("i-pop", "s1", { kind: "browser", refId: "pop", title: "Google" }),
  ] } });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-br");
  await store.getState().openItem("i-pop");
  let closeTab: (m: { browserId: string }) => void = () => {};
  const off = vi.fn();
  const links = { setOpenIn() {}, onOpenInRealm: () => () => {}, onCloseTab: (cb: typeof closeTab) => { closeTab = cb; return off; } };
  const unsubscribe = subscribeSelfClosedTabs(store, links);
  return { api, store, closeTab: (browserId: string) => closeTab({ browserId }), off, unsubscribe };
}

describe("a browser tab whose page closed itself", () => {
  it("deletes its item, as the tab's × does, and leaves the browser that opened it", async () => {
    // THE MUTANT: close it out of the layout only. The popup's row stays in the space, one more for
    // every sign-in that closes its own window.
    const { api, store, closeTab } = await popupOpen();
    closeTab("pop");
    await vi.waitFor(() => expect(api.calls).toContain("deleteItem:i-pop"));
    expect(store.getState().items.filter((i) => i.refId === "pop")).toHaveLength(0);
    expect(api.data.items.s1!.filter((i) => i.kind === "browser").map((i) => i.id)).toEqual(["i-br"]);
    expect(allItems(store.getState().layout!)).not.toContain("i-pop");
  });

  it("leaves everything alone for a browser it does not know", async () => {
    const { api, store, closeTab } = await popupOpen();
    closeTab("elsewhere");
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls.some((c) => c.startsWith("deleteItem"))).toBe(false);
    expect(store.getState().items).toHaveLength(2);
  });

  it("lets go of main's event when unsubscribed", async () => {
    const { off, unsubscribe } = await popupOpen();
    unsubscribe?.();
    expect(off).toHaveBeenCalledOnce();
  });
});

/** A session's side pane holding pages A, B and C, B showing — and main's self-close captured. */
async function strip() {
  const api = fakeApi({
    items: { s1: [
      item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }),
      item("i-a", "s1", { kind: "browser", refId: "a", title: "A" }),
      item("i-b", "s1", { kind: "browser", refId: "b", title: "B" }),
      item("i-c", "s1", { kind: "browser", refId: "c", title: "C" }),
    ] },
    sessions: [session("lead", "s1")],
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  for (const id of ["i-a", "i-b", "i-c"]) await store.getState().openInSidePane("lead", id);
  const pane = () => findSidePane(store.getState().layout!, "i-lead")!;
  await store.getState().openItem("i-b", pane().id);
  let closeTab: (m: { browserId: string }) => void = () => {};
  subscribeSelfClosedTabs(store, { setOpenIn() {}, onOpenInRealm: () => () => {}, onCloseTab: (cb: typeof closeTab) => { closeTab = cb; return () => {}; } });
  /** The newest page, as main names it when the page closes itself. */
  const closeNewest = async () => {
    const d = store.getState().items.filter((i) => i.kind === "browser").at(-1)!;
    closeTab({ browserId: d.refId });
    await vi.waitFor(() => expect(pane().tabs).not.toContain(d.id));
  };
  return { store, pane, closeNewest };
}

describe("a page that opened from another tab and closed itself", () => {
  it("brings the tab that opened it forward, not its neighbour", async () => {
    // THE MUTANT: never use the opener. C, the neighbour after it, comes forward instead.
    const { store, pane, closeNewest } = await strip();
    await store.getState().openPageTab("b", "https://example.com/pay", { background: false, focus: true });
    expect(pane().tabs).toHaveLength(4);
    await closeNewest();
    expect(pane()).toMatchObject({ itemId: "i-b", tabs: ["i-a", "i-b", "i-c"] });
  });

  it("brings the opener forward after a middle-click's tab was chosen and closed", async () => {
    const { store, pane, closeNewest } = await strip();
    await store.getState().openPageTab("b", "https://example.com/later", { background: true, focus: true });
    const d = pane().tabs!.find((t) => !["i-a", "i-b", "i-c"].includes(t))!;
    await store.getState().openItem(d, pane().id);
    await closeNewest();
    expect(pane().itemId).toBe("i-b");
  });

  it("brings the neighbour forward when another tab was chosen in between", async () => {
    // THE MUTANT: keep the link through a selection. C was looked at, then the page; B jumping forward
    // would be a tab the person moved away from.
    const { store, pane, closeNewest } = await strip();
    await store.getState().openPageTab("b", "https://example.com/pay", { background: false, focus: true });
    const d = pane().itemId!;
    await store.getState().openItem("i-c", pane().id);
    await store.getState().openItem(d, pane().id);
    await closeNewest();
    expect(pane().itemId).toBe("i-c");
  });

  it("brings the neighbour forward when the opener has left the strip", async () => {
    // THE MUTANT: skip the check that the opener is still in this strip — the pane shows nothing.
    const { store, pane, closeNewest } = await strip();
    await store.getState().openPageTab("b", "https://example.com/pay", { background: false, focus: true });
    await store.getState().closeFromLayout("i-b");
    await closeNewest();
    expect(pane()).toMatchObject({ itemId: "i-c", tabs: ["i-a", "i-c"] });
  });

  it("brings the neighbour forward for a tab no page opened", async () => {
    const { store, pane, closeNewest } = await strip();
    await store.getState().openLinkInBrowser("https://example.com/link", {});
    expect(pane().tabs).toHaveLength(4);
    await closeNewest();
    expect(pane().itemId).toBe("i-c");
  });
});
