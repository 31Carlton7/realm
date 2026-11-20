import { describe, expect, it, vi } from "vitest";
import { allItems } from "@realm/contracts";
import { subscribeSelfClosedTabs } from "./App";
import { createAppStore } from "./state/store";
import { fakeApi, item } from "./state/store.test-fakes";

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
