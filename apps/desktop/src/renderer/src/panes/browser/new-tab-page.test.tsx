import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { findSidePane, type Layout } from "@realm/contracts";
import { PaneHost } from "../../components/PaneHost";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { setBrowserBridgesForTests } from "./browser-client";
import { fakeBrowserBridges } from "./browser-bridges.test-fakes";
import { BrowserPane } from "./BrowserPane";
import { registerPane } from "../registry";

// The one pane kind these tests open for real; App registers every kind at boot.
registerPane("browser", BrowserPane);

/**
 * A blank tab as the person meets it (W6): the session's tools where an empty page would be, each
 * one opening in the tab's place.
 */

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  setBrowserBridgesForTests(fakeBrowserBridges());
});
afterEach(() => { cleanup(); setBrowserBridgesForTests(null); vi.unstubAllGlobals(); });

/** The lead with a side pane whose only tab is a blank browser — what "+ › New tab" leaves. */
async function mount() {
  const api = fakeApi({ items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" })] }, sessions: [session("lead", "s1")] });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  await store.getState().newTab();
  const host = (layout: Layout) => (
    <StoreContext.Provider value={store}>
      <PaneHost layout={layout} items={store.getState().items} focusedLeafId={store.getState().focusedLeafId}
        onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />
    </StoreContext.Provider>
  );
  render(host(store.getState().layout!));
  return { api, store };
}
const page = async () => within(await screen.findByRole("region", { name: "New tab" }));

describe("a blank tab's new-tab page", () => {
  it("lists the session's tools, Documents first with the chord the keymap gives finding a file", async () => {
    // THE MUTANT: print ⌘P from a literal. A user who moved "Open a file" elsewhere is shown a key
    // that no longer opens it. And no Files row: finding a file is the documents pane's own search,
    // and a second row for it opened the same search somewhere else.
    const { store } = await mount();
    store.setState({ keybindings: [...store.getState().keybindings, { key: "mod+p", command: "" }, { key: "mod+o", command: "palette.files" }] });
    const tools = within((await page()).getByRole("region", { name: "Tools" }));
    const rows = tools.getAllByRole("button");
    expect(rows.map((r) => r.querySelector(".new-tab-row-label")!.textContent)).toEqual(["Documents", "Terminal", "Agents", "Simulator", "Machine"]);
    expect(rows[0]!.querySelector("kbd")?.textContent).toBe("⌘O");
    expect(rows.slice(1).every((r) => r.querySelector("kbd") === null)).toBe(true);
  });

  it("opens the session's Agents in the tab's place — the page is how a session with no side pane reaches them", async () => {
    // THE MUTANT: leave Agents off the page. The toggle at the window's top right opens a session's
    // first side pane onto this page, so its sub-agents would be two menus away, not one row.
    const { api, store } = await mount();
    const blank = findSidePane(store.getState().layout!, "i-lead")!.itemId!;
    fireEvent.click((await page()).getByRole("button", { name: "Agents" }));
    await waitFor(() => {
      const side = findSidePane(store.getState().layout!, "i-lead")!;
      expect(store.getState().items.find((i) => i.id === side.itemId)?.kind).toBe("agents");
    });
    expect(api.calls).toContain("agentsTab:lead");
    expect(store.getState().items.some((i) => i.id === blank)).toBe(false);
  });

  it("opens Terminal in the tab's place", async () => {
    const { store } = await mount();
    const blank = findSidePane(store.getState().layout!, "i-lead")!.itemId!;
    fireEvent.click((await page()).getByRole("button", { name: "Terminal" }));
    await waitFor(() => {
      const side = findSidePane(store.getState().layout!, "i-lead")!;
      expect(side.tabs).toHaveLength(1);
      expect(store.getState().items.find((i) => i.id === side.itemId)?.kind).toBe("terminal");
    });
    expect(store.getState().items.some((i) => i.id === blank)).toBe(false);
  });

  it("opens Documents in the tab's place, not the palette", async () => {
    const { store } = await mount();
    fireEvent.click((await page()).getByRole("button", { name: /^Documents/ }));
    await waitFor(() => {
      const side = findSidePane(store.getState().layout!, "i-lead")!;
      expect(store.getState().items.find((i) => i.id === side.itemId)?.kind).toBe("documents");
    });
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("lists the profile's recent pages, and one chosen loads in this tab rather than a new one", async () => {
    // THE MUTANT: open the page as a tab of its own. "+ › New tab › Delta careers" would leave the
    // blank tab standing beside it — the thing a tool taking the tab's place exists to prevent.
    const navigated: string[] = [];
    setBrowserBridgesForTests(fakeBrowserBridges({
      server: { recent: async () => [{ url: "https://jobs.example/delta", title: "Delta careers", visits: 1, lastVisitAt: 1, favicon: "" }] },
      host: { navigate: async (id, input) => { navigated.push(`${id} ${input}`); return input; } },
    }));
    const { api, store } = await mount();
    const side = () => findSidePane(store.getState().layout!, "i-lead")!;
    const blank = store.getState().items.find((i) => i.id === side().itemId)!;
    const made = api.calls.filter((c) => c.startsWith("createBrowser:")).length;
    const recent = await (await page()).findByRole("region", { name: "Recently visited" });
    fireEvent.click(within(recent).getByRole("button", { name: "Delta careers" }));
    await waitFor(() => expect(navigated).toEqual([`${blank.refId} https://jobs.example/delta`]));
    expect(side().tabs).toEqual([blank.id]);
    expect(api.calls.filter((c) => c.startsWith("createBrowser:"))).toHaveLength(made);
  });

});
