import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { activeGroup, findLeafOfItem, findSidePane, type Layout } from "@realm/contracts";
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
async function mount(items = ITEMS) {
  const api = fakeApi({ items: { s1: [...items] }, sessions: [session("lead", "s1"), session("kid", "s1")] });
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

describe("a browser tab's mark", () => {
  /** A favicon as the item carries one: the picture itself, a 16px ICO's first bytes, in a data: URL. */
  const ICON = "data:image/x-icon;base64,AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQ";
  const withIcon = (favicon: string) => ITEMS.map((it) => (it.id === "i-br" ? { ...it, favicon } : it));
  const mark = (name: string) => strip().getByRole("tab", { name });

  it("is the page's own icon once the page has offered one, as a browser's tabs are", async () => {
    // THE mutant: the kind's glyph on every tab — the report this answers: a Google search drawn with
    // the globe instead of Google's G.
    await mount(withIcon(ICON));
    expect(mark("Delta careers").querySelector("img.page-icon")?.getAttribute("src")).toBe(ICON);
    expect(mark("Delta careers").querySelector("svg")).toBeNull();
    // The session beside it keeps its kind's glyph: only a browser has a page to take a mark from.
    expect(mark("Agent: apply").querySelector("img")).toBeNull();
  });

  it("is the browser's glyph until then, and for anything that is not a picture held in hand", async () => {
    await mount();
    expect(mark("Delta careers").querySelector("img")).toBeNull();
    expect(mark("Delta careers").querySelector("svg")).not.toBeNull();
    cleanup();
    // THE mutant: draw whatever the row holds. An address would have this window fetch it, past a CSP
    // that admits no remote image — a broken picture at best.
    await mount(withIcon("https://www.google.com/favicon.ico"));
    expect(mark("Delta careers").querySelector("img")).toBeNull();
  });

  it("goes back to the glyph when the picture will not draw — never a broken image", async () => {
    await mount(withIcon(ICON));
    const img = mark("Delta careers").querySelector("img.page-icon")!;
    fireEvent.error(img);
    expect(mark("Delta careers").querySelector("img")).toBeNull();
    expect(mark("Delta careers").querySelector("svg")).not.toBeNull();
  });

  it("heads a browser's own pane too, where a single pane's glyph goes", async () => {
    const api = fakeApi({ items: { s1: [item("i-br", "s1", { kind: "browser", refId: "br", title: "hi - Google Search", favicon: ICON })] } });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-br");
    render(
      <StoreContext.Provider value={store}>
        <PaneHost layout={store.getState().layout!} items={store.getState().items} focusedLeafId={store.getState().focusedLeafId}
          onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />
      </StoreContext.Provider>,
    );
    // THE mutant: the bar's own glyph left as the kind's. The tab strip and the bar would disagree.
    expect(document.querySelector(".panel-icon img.page-icon")?.getAttribute("src")).toBe(ICON);
  });
});

describe("the strip's +", () => {
  it("offers a new tab and a new tab in full view, each with the chord the keymap gives it", async () => {
    // THE MUTANT: print the chord from a literal, or from the wrong command — a rebound user would
    // be shown a shortcut that no longer does this.
    const { store } = await mount();
    // The user moved New tab off ⌘⇧B: an unbind claims the old key, a later rule the new one.
    store.setState({ keybindings: [...store.getState().keybindings, { key: "mod+shift+b", command: "" }, { key: "mod+alt+n", command: "pane.newTab" }] });
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const menu = within(await screen.findByRole("menu", { name: "New tab" }));
    const rows = menu.getAllByRole("menuitem");
    expect(rows.map((r) => r.querySelector(".menu-label")!.textContent)).toEqual(["New tab", "New tab in full view"]);
    expect(rows.map((r) => r.querySelector(".menu-kbd")?.textContent)).toEqual(["⌘⌥N", "⌘⌥B"]);
  });

  it("adds a blank tab to this strip on New tab", async () => {
    // THE MUTANT: a + that calls newTab with no leaf. The keyboard is in ANOTHER session here, so the
    // tab would land in that session's side pane instead of the strip whose + was clicked.
    const { api, store, rerender } = await mount();
    api.data.items.s1!.push(item("i-other", "s1", { kind: "session", refId: "other", title: "Other" }));
    api.data.sessions.push(session("other", "s1"));
    await store.getState().refreshItems();
    await store.getState().openItemAt("i-other", findLeafOfItem(store.getState().layout!, "i-lead")!.id, "left");
    rerender();
    expect(store.getState().focusedLeafId).toBe(findLeafOfItem(store.getState().layout!, "i-other")!.id);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "New tab" })).getAllByRole("menuitem")[0]!);
    await waitFor(() => expect(side(store).tabs).toHaveLength(3));
    // After the tab showing, and on screen itself — the order a browser gives a tab you asked for.
    const fresh = side(store).itemId!;
    expect(side(store).tabs).toEqual(["i-br", fresh, "i-kid"]);
    expect(store.getState().items.find((i) => i.id === fresh)?.kind).toBe("browser");
  });

  it("fills the host with this pane on New tab in full view", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "New tab" })).getAllByRole("menuitem")[1]!);
    await waitFor(() => expect(activeGroup(store.getState().groups!).zoomedLeafId).toBe(side(store).id));
  });
});

describe("what a side pane keeps mounted", () => {
  it("every browser tab, hidden behind the one showing — a browser with no pane is a page no agent can drive", async () => {
    const { store, rerender } = await mount();
    await store.getState().openItem("i-kid", side(store).id);
    rerender();
    // THE MUTANT: mount only the tab showing. The browser behind the preview loses its pane, main
    // retains it (and evicts the fourth such view), and an agent's next call on it is refused.
    const slots = [...document.querySelectorAll<HTMLElement>(`[data-leaf-id="${side(store).id}"] .pane-slot`)];
    expect(slots).toHaveLength(2);
    expect(slots.filter((s) => s.hidden)).toHaveLength(1);
    expect(slots.find((s) => s.hidden)!.textContent).toContain("Delta careers");
    expect(slots.find((s) => !s.hidden)!.textContent).toContain("Agent: apply");
  });
});

describe("who yields in a side pane's bar", () => {
  it("a session tab's own actions go to the ⋯ menu, so the tabs keep their names", async () => {
    // THE MUTANT: the bar's ordinary budget. A session's six actions take the bar and every tab
    // shrinks to an ellipsis ("Age…", "Jo…") — measured in the live check before this.
    const { store, rerender } = await mount();
    await store.getState().openItem("i-kid", side(store).id);
    rerender();
    const bar = document.querySelector<HTMLElement>(`[data-leaf-id="${side(store).id}"] .panel-bar`)!;
    expect(within(bar).queryByRole("button", { name: "Files for Agent: apply" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Pane menu for Agent: apply" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Files/ })).toBeInTheDocument();
  });
});
