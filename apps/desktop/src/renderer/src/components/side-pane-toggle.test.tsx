import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../panes";
import { AppShell } from "../App";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session, type FakeData } from "../state/store.test-fakes";
import { setBrowserBridgesForTests } from "../panes/browser/browser-client";
import { fakeBrowserBridges } from "../panes/browser/browser-bridges.test-fakes";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  setBrowserBridgesForTests(fakeBrowserBridges());
});
afterEach(() => { cleanup(); setBrowserBridgesForTests(null); vi.unstubAllGlobals(); });

/** The shell with the lead on screen, and — unless told otherwise — a side pane holding a browser. */
async function mount(over: FakeData = {}, opts: { sidePane?: boolean; open?: string } = {}) {
  const api = fakeApi({
    items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }), item("i-br", "s1", { kind: "browser", refId: "br", title: "Delta careers" })] },
    sessions: [session("lead", "s1")],
    ...over,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem(opts.open ?? "i-lead");
  if (opts.sidePane !== false) await store.getState().openInSidePane("lead", "i-br");
  render(<StoreContext.Provider value={store}><AppShell /></StoreContext.Provider>);
  return { api, store };
}

const toggle = () => screen.queryByRole("button", { name: /(Hide|Show) side pane/ });

describe("the side panes' toggle at the window's top right", () => {
  it("is lit while the side pane is out, puts it away on a click, and brings it back on the next", async () => {
    // THE MUTANT: a toggle that reads the layout alone and not `sidePanesHidden` — it would stay lit
    // over a side pane nobody can see.
    const { store } = await mount();
    expect(toggle()).toHaveAccessibleName("Hide side pane");
    expect(toggle()).toHaveAttribute("data-on");
    expect(toggle()!.closest(".window-trail")).not.toBeNull();
    fireEvent.click(toggle()!);
    await waitFor(() => expect(store.getState().sidePanesHidden).toBe(true));
    expect(toggle()).toHaveAccessibleName("Show side pane");
    expect(toggle()).not.toHaveAttribute("data-on");
    fireEvent.click(toggle()!);
    await waitFor(() => expect(store.getState().sidePanesHidden).toBe(false));
  });

  it("is offered beside a session with no side pane yet, and not over a page or where no session is", async () => {
    await mount({}, { sidePane: false });
    expect(toggle()).toHaveAccessibleName("Show side pane");
    cleanup();
    const { store } = await mount();
    act(() => store.getState().openDestinationPage("library-page"));
    await waitFor(() => expect(toggle()).toBeNull());
    cleanup();
    await mount({ items: { s1: [item("i-f", "s1", { kind: "artifact", refId: "f1", title: "notes.md" })] }, sessions: [] }, { sidePane: false, open: "i-f" });
    expect(toggle()).toBeNull();
  });
});
