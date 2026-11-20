import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QuickChatBridge } from "./App";
import { StoreContext, createAppStore } from "./state/store";
import { fakeApi } from "./state/store.test-fakes";

/* The store already follows a chat deleted elsewhere when it is told to look (store-quick-chat-panel.test.ts).
   The bridge is the telling, so THE mutants are a window that never listens, and one that keeps
   listening after it is gone. */
afterEach(() => { cleanup(); delete (window as { realm?: unknown }).realm; });

/** A Realm window and the panel as two stores on one home, with main's word to the window in hand. */
async function windowBesidePanel() {
  const api = fakeApi();
  let changed = () => {};
  const off = vi.fn();
  const as = (surface: "quick-chat" | undefined) => {
    (window as { realm?: unknown }).realm = { surface, quickChatPanel: { chatChanged: () => {}, onChatChanged: (cb: () => void) => { changed = cb; return off; } } };
  };
  const win = createAppStore(api);
  const panel = createAppStore(api);
  as(undefined);
  await win.getState().boot();
  await win.getState().openQuickChat();
  as("quick-chat");
  await panel.getState().showQuickChatPanel();
  as(undefined);
  const { unmount } = render(<StoreContext.Provider value={win}><QuickChatBridge /></StoreContext.Provider>);
  return {
    win, off, unmount, changed: () => changed(),
    panelDeletes: async () => { as("quick-chat"); await panel.getState().closeQuickChat(); as(undefined); },
    deleted: () => api.calls.filter((c) => c.startsWith("deleteSession:")).length,
  };
}

it("takes the window's card down when main says the panel deleted the chat, and deletes nothing itself", async () => {
  const h = await windowBesidePanel();
  expect(h.win.getState().quickChat).not.toBeNull();
  await h.panelDeletes();
  expect(h.win.getState().quickChat).not.toBeNull();
  h.changed();
  await waitFor(() => expect(h.win.getState().quickChat).toBeNull());
  expect(h.deleted()).toBe(1);
});

it("stops listening when the window goes", async () => {
  const h = await windowBesidePanel();
  h.unmount();
  expect(h.off).toHaveBeenCalledOnce();
});

it("draws nothing and asks nothing where there is no bridge, as in a browser or jsdom", () => {
  const store = createAppStore(fakeApi());
  const { container } = render(<StoreContext.Provider value={store}><QuickChatBridge /></StoreContext.Provider>);
  expect(container).toBeEmptyDOMElement();
});
