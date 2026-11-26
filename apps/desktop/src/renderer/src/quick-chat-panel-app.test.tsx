import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fakeApi, type FakeApi, type FakeData } from "./state/store.test-fakes";

let api: FakeApi;
vi.mock("./state/live-api", () => ({ liveApi: () => api }));
vi.mock("./rpc/client", () => ({ rpc: () => ({ on: () => () => {}, onStatusChange: () => () => {}, call: async () => ({}) }) }));

import { QuickChatPanelApp } from "./QuickChatPanelApp";

/** Main, as the panel's page sees it: it can be asked to put the panel away, and says when it opened. */
function mount(overrides: FakeData = {}, { opening = true } = {}) {
  api = fakeApi(overrides);
  const hide = vi.fn();
  const fit = vi.fn();
  let shown = () => {};
  let changed = () => {};
  (window as any).realm = { surface: "quick-chat", quickChatPanel: {
    hide, fit, chatChanged: () => {}, opening: async () => opening,
    onShown: (cb: () => void) => { shown = cb; return () => {}; },
    onChatChanged: (cb: () => void) => { changed = cb; return () => {}; },
  } };
  render(<QuickChatPanelApp />);
  return { hide, fit, shown: () => act(async () => { shown(); }), changed: () => act(async () => { changed(); }) };
}

const made = () => api.calls.filter((c) => c.startsWith("startQuickChat:")).length;
const deleted = () => api.calls.filter((c) => c.startsWith("deleteSession:")).length;

afterEach(() => { cleanup(); delete (window as any).realm; delete document.documentElement.dataset.surface; });

describe("the quick chat panel's page", () => {
  it("draws the quick chat alone, with a chat ready, and says which surface it is", async () => {
    mount();
    expect(await screen.findByRole("dialog", { name: "Quick chat" })).toBeInTheDocument();
    expect(document.documentElement.dataset.surface).toBe("quick-chat");
    expect(document.querySelector(".app")).toBeNull();
    expect(made()).toBe(1);
  });

  it("makes one chat when main's first word arrives while it is still starting", async () => {
    const main = mount();
    await main.shown();
    await screen.findByRole("dialog", { name: "Quick chat" });
    await main.shown();
    await waitFor(() => expect(made()).toBe(1));
  });

  it("made ahead of the first press, starts no chat until it is opened", async () => {
    const main = mount({}, { opening: false });
    // Long enough for a page that does show at load to have made its chat (the first test's, ~10ms).
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(api.calls.some((c) => c.startsWith("listSpaces"))).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Quick chat" })).toBeNull();
    expect(made()).toBe(0);
    await main.shown();
    expect(await screen.findByRole("dialog", { name: "Quick chat" })).toBeInTheDocument();
    expect(made()).toBe(1);
  });

  it("Escape puts the panel away and deletes nothing, even an empty chat", async () => {
    const main = mount();
    await screen.findByRole("dialog", { name: "Quick chat" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    // It narrows into its right end first, as ChatGPT's bar does, and then main hides the window.
    expect(document.documentElement.dataset.panelOut).toBe("");
    expect(main.hide).not.toHaveBeenCalled();
    await waitFor(() => expect(main.hide).toHaveBeenCalledTimes(1));
    expect(deleted()).toBe(0);
    expect(screen.getByRole("dialog", { name: "Quick chat" })).toBeInTheDocument();
  });

  it("leaves Escape to whatever already used it", async () => {
    const main = mount();
    await screen.findByRole("dialog", { name: "Quick chat" });
    const used = (e: KeyboardEvent) => e.preventDefault();
    document.body.addEventListener("keydown", used);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.body.removeEventListener("keydown", used);
    await act(async () => {});
    expect(main.hide).not.toHaveBeenCalled();
    expect(deleted()).toBe(0);
  });

  it("is put away when its chat is deleted from its own bar", async () => {
    const main = mount();
    await screen.findByRole("dialog", { name: "Quick chat" });
    fireEvent.click(screen.getByRole("button", { name: "Close quick chat" }));
    await waitFor(() => expect(main.hide).toHaveBeenCalledTimes(1));
    expect(deleted()).toBe(1);
  });

  it("is put away when a window deleted the chat, and opens on a new one", async () => {
    const main = mount();
    await screen.findByRole("dialog", { name: "Quick chat" });
    api.data.settings["ui.quickChat"] = { sessionId: null, pos: null };
    await main.changed();
    await waitFor(() => expect(main.hide).toHaveBeenCalledTimes(1));
    await main.shown();
    expect(await screen.findByRole("dialog", { name: "Quick chat" })).toBeInTheDocument();
    expect(made()).toBe(2);
  });

  it("tells main how tall its shapes are, so the window is the bar until there is more", async () => {
    const main = mount();
    await screen.findByRole("dialog", { name: "Quick chat" });
    await waitFor(() => expect(main.fit).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "Quick chat" }).dataset.grown).toBeUndefined();
  });

  it("puts the empty bar away when the keyboard leaves it, and keeps one with something typed", async () => {
    const main = mount();
    await screen.findByRole("dialog", { name: "Quick chat" });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "half a question" } });
    fireEvent.blur(window);
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(main.hide).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "" } });
    fireEvent.blur(window);
    await waitFor(() => expect(main.hide).toHaveBeenCalledTimes(1));
    expect(deleted()).toBe(0);
  });

  it("stays up to say why, in a home with no space to run a chat in", async () => {
    const main = mount({ spaces: [] });
    expect(await screen.findByText("Make a space in Realm first. A quick chat runs in one.")).toBeInTheDocument();
    expect(main.hide).not.toHaveBeenCalled();
    expect(made()).toBe(0);
  });
});
