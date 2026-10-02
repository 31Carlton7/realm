import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { findSidePane, type Layout } from "@realm/contracts";
import { PaneHost } from "../../components/PaneHost";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { setBrowserBridgesForTests } from "./browser-client";
import { fakeBrowserBridges } from "./browser-bridges.test-fakes";
import { NewTabPage } from "./NewTabPage";
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
  it("lists the session's tools, Files with the chord the keymap gives the file palette", async () => {
    // THE MUTANT: print ⌘P from a literal. A user who moved "Open a file" elsewhere is shown a key
    // that no longer opens it.
    const { store } = await mount();
    store.setState({ keybindings: [...store.getState().keybindings, { key: "mod+p", command: "" }, { key: "mod+o", command: "palette.files" }] });
    const tools = within((await page()).getByRole("region", { name: "Tools" }));
    const rows = tools.getAllByRole("button");
    expect(rows.map((r) => r.querySelector(".new-tab-row-label")!.textContent)).toEqual(["Files", "Terminal", "Documents", "Simulator", "Machine"]);
    expect(rows[0]!.querySelector("kbd")?.textContent).toBe("⌘O");
    expect(rows.slice(1).every((r) => r.querySelector("kbd") === null)).toBe(true);
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

  it("opens the file palette from Files", async () => {
    const { store } = await mount();
    fireEvent.click((await page()).getByRole("button", { name: /^Files/ }));
    await waitFor(() => expect(store.getState()).toMatchObject({ paletteOpen: true, paletteMode: "files" }));
  });

  it("lists the profile's recent pages, and one chosen loads in this tab rather than a new one", async () => {
    // THE MUTANT: open the page as a tab of its own. "+ › New tab › Delta careers" would leave the
    // blank tab standing beside it — the thing a tool taking the tab's place exists to prevent.
    const navigated: string[] = [];
    setBrowserBridgesForTests(fakeBrowserBridges({
      server: { recent: async () => [{ url: "https://jobs.example/delta", title: "Delta careers", visits: 1, lastVisitAt: 1 }] },
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

  it("draws no Recently visited until there are visits to draw, and opens one that is there", () => {
    // With no visits the section is absent rather than empty. THE MUTANT: render the heading
    // unconditionally, and a profile that has been nowhere gets a heading over nothing.
    const { unmount } = render(<NewTabPage itemId="i-b" />);
    expect(screen.queryByRole("region", { name: "Recently visited" })).toBeNull();
    unmount();
    const onVisit = vi.fn();
    render(<NewTabPage itemId="i-b" recent={[{ url: "https://jobs.example/delta", title: "Delta careers" }]} onVisit={onVisit} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Recently visited" })).getByRole("button", { name: "Delta careers" }));
    expect(onVisit).toHaveBeenCalledWith("https://jobs.example/delta");
  });
});
