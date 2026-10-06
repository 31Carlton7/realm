import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TERMINALS_DOCK_KEY, findLeafOfItem, findSidePane, tabOwner, type Environment, type Layout } from "@realm/contracts";
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
afterEach(() => { cleanup(); setBrowserBridgesForTests(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ITEMS = [
  item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }),
  item("i-br", "s1", { kind: "browser", refId: "br", title: "Delta careers" }),
  item("i-kid", "s1", { kind: "session", refId: "kid", title: "Agent: apply" }),
];

/** The lead's checkout, loaded — what its Documents waits for. */
const ENV: Environment = { id: "env-lead", spaceId: "s1", path: "/tmp/lead", branch: "main", kind: "primary", portBlockStart: 41000, createdAt: 0, updatedAt: 0 };

/** The lead with a side pane holding a browser and a previewed child, the browser showing. */
async function mount(items = ITEMS, settings: Record<string, unknown> = {}) {
  const api = fakeApi({ items: { s1: [...items] }, sessions: [session("lead", "s1", { environmentId: ENV.id, cwd: ENV.path }), session("kid", "s1")],
    environments: { s1: [ENV] }, settings });
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

describe("several sessions' tabs in one strip", () => {
  /** Lead with a browser and a previewed child, and Other beside it with a browser of its own. */
  async function two() {
    const items = [...ITEMS, item("i-other", "s1", { kind: "session", refId: "other", title: "Other" }),
      item("i-ob", "s1", { kind: "browser", refId: "ob", title: "Other docs" })];
    const api = fakeApi({ items: { s1: items }, sessions: [session("lead", "s1"), session("kid", "s1"), session("other", "s1")] });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    await store.getState().openItemAt("i-other", findLeafOfItem(store.getState().layout!, "i-lead")!.id, "right");
    await store.getState().openInSidePane("lead", "i-br");
    await store.getState().openInSidePane("lead", "i-kid");
    await store.getState().openInSidePane("other", "i-ob");
    const host = () => (
      <StoreContext.Provider value={store}>
        <PaneHost layout={store.getState().layout!} items={store.getState().items} focusedLeafId={store.getState().focusedLeafId}
          onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />
      </StoreContext.Provider>
    );
    const r = render(host());
    return { api, store, rerender: () => r.rerender(host()) };
  }
  const paneOf = (store: Awaited<ReturnType<typeof two>>["store"], itemId: string) =>
    document.querySelector(`.panel[data-leaf-id="${findLeafOfItem(store.getState().layout!, itemId)!.id}"]`)!;
  const carry = (id: string) => ({ types: ["application/x-realm-item"], getData: () => id, setData: () => {} });

  it("says whose each tab is, quietly: a hairline between runs, the session in the tooltip, its pane marked under the pointer", async () => {
    // THE MUTANTS: no cue at all (whose tab is this?), or a loud one — a label per run — that takes the
    // strip's width from the tabs.
    const { store } = await two();
    expect(strip().getAllByRole("tab").map((t) => t.textContent)).toEqual(["Delta careers", "Agent: apply", "Other docs"]);
    expect(document.querySelectorAll(".pane-tab-run")).toHaveLength(1);
    expect(document.querySelector(".pane-tab-run")!.nextElementSibling!.textContent).toContain("Other docs");
    expect(strip().getByRole("tab", { name: "Delta careers" })).toHaveAttribute("title", "Delta careers — Lead");
    expect(strip().getByRole("tab", { name: "Other docs" })).toHaveAttribute("title", "Other docs — Other");
    fireEvent.pointerEnter(strip().getByRole("tab", { name: "Other docs" }).parentElement!);
    expect(paneOf(store, "i-other")).toHaveAttribute("data-owner-hover");
    expect(paneOf(store, "i-lead")).not.toHaveAttribute("data-owner-hover");
    fireEvent.pointerEnter(strip().getByRole("tab", { name: "Delta careers" }).parentElement!);
    expect(paneOf(store, "i-lead")).toHaveAttribute("data-owner-hover");
    expect(paneOf(store, "i-other")).not.toHaveAttribute("data-owner-hover");
    fireEvent.pointerLeave(screen.getByRole("tablist", { name: "Tabs" }));
    expect(document.querySelectorAll("[data-owner-hover]")).toHaveLength(0);
  });

  it("marks the pane of the session whose tab the keyboard is in", async () => {
    const { store, rerender } = await two();
    await store.getState().openItem("i-ob");
    rerender();
    expect(paneOf(store, "i-other")).toHaveAttribute("data-owner-active");
    expect(paneOf(store, "i-lead")).not.toHaveAttribute("data-owner-active");
  });

  it("wears none of it while one session's tabs are the strip", async () => {
    await mount();
    expect(document.querySelectorAll(".pane-tab-run")).toHaveLength(0);
    expect(strip().getByRole("tab", { name: "Delta careers" })).toHaveAttribute("title", "Delta careers");
  });

  it("a tab dropped on another session's tab joins that session's run, and leaves with it", async () => {
    const { store } = await two();
    const target = strip().getByRole("tab", { name: "Other docs" }).parentElement!;
    fireEvent.dragOver(target, { dataTransfer: carry("i-br") });
    fireEvent.drop(target, { dataTransfer: carry("i-br") });
    await waitFor(() => expect(side(store).tabs).toEqual(["i-kid", "i-br", "i-ob"]));
    expect(tabOwner(side(store), "i-br")).toBe("i-other");
    await store.getState().closeInPane(findLeafOfItem(store.getState().layout!, "i-other")!.id);
    expect(side(store).tabs).toEqual(["i-kid"]);
    expect(store.getState().view!.sidePanes["i-other"]?.tabs).toEqual(["i-br", "i-ob"]);
  });

  it("lands after a tab when the pointer is on its far half — the only way to the end of a run another follows", async () => {
    const { store } = await two();
    const target = strip().getByRole("tab", { name: "Agent: apply" }).parentElement!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 28, width: 100, height: 28, x: 0, y: 0, toJSON: () => ({}) });
    // jsdom has no DragEvent, so the pointer's x is put on the event by hand.
    const at80 = (make: typeof createEvent.dragOver) => {
      const e = make(target, { dataTransfer: carry("i-br") });
      Object.defineProperty(e, "clientX", { value: 80 });
      return e;
    };
    fireEvent(target, at80(createEvent.dragOver));
    expect(target).toHaveAttribute("data-over", "after");
    fireEvent(target, at80(createEvent.drop));
    await waitFor(() => expect(side(store).tabs).toEqual(["i-kid", "i-br", "i-ob"]));
    expect(tabOwner(side(store), "i-br")).toBe("i-lead");
  });

  it("choosing a tab shows it and hands the caret back to the prompter that had it", async () => {
    // THE MUTANT: leave the keyboard on the tab. The person was typing; the next key would go nowhere.
    await two();
    const prompter = document.createElement("textarea");
    document.body.appendChild(prompter);
    prompter.focus();
    const tab = strip().getByRole("tab", { name: "Other docs" });
    fireEvent.pointerDown(tab);
    tab.focus();
    fireEvent.click(tab);
    expect(document.activeElement).toBe(prompter);
    prompter.remove();
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
    expect(rows.slice(0, 2).map((r) => r.querySelector(".menu-label")!.textContent)).toEqual(["New tab", "New tab in full view"]);
    expect(rows.slice(0, 2).map((r) => r.querySelector(".menu-kbd")?.textContent)).toEqual(["⌘⌥N", "⌘⌥B"]);
  });

  it("offers every tool of the session it serves, under the new tab — where the session's bar kept them", async () => {
    // THE MUTANT: drop the tools from the menu. Machine, Simulator and Agents would then have no way in
    // from the side pane at all, now that the session's bar carries none of them.
    const { store } = await mount();
    await waitFor(() => expect(store.getState().environments[ENV.id]).toBeDefined());
    // ⌘J moved, to check the row prints the chord the keymap gives the SESSION'S terminal.
    store.setState({ keybindings: [...store.getState().keybindings, { key: "mod+j", command: "" }, { key: "mod+alt+t", command: "terminal.toggle", when: "!overlayOpen && sessionFocus" }] });
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const rows = within(await screen.findByRole("menu", { name: "New tab" })).getAllByRole("menuitem");
    const named = rows.map((r) => [r.querySelector(".menu-label")!.textContent, r.querySelector(".menu-kbd")?.textContent ?? null]);
    expect(named.slice(2)).toEqual([["Documents", "⌘P"], ["Terminal", "⌘⌥T"], ["Agents", null], ["Simulator", null], ["Machine", null]]);
  });

  it.each([
    ["Simulator", "createSimulator:s1", "simulator"],
    ["Machine", "createMachine:s1", "machine"],
    ["Agents", "agentsTab:lead", "agents"],
    ["Terminal", "createTerminal:s1:/tmp/lead", "terminal"],
    ["Documents", "createDocuments:s1:env-lead", "documents"],
  ] as const)("opens %s as a tab of THIS strip, with the keyboard", async (row, call, kind) => {
    // THE MUTANT: open the tool with no session named. It lands wherever the keyboard is — replacing
    // the pane in focus, or in another session's side pane.
    const { api, store } = await mount();
    await waitFor(() => expect(store.getState().environments[ENV.id]).toBeDefined());
    // The keyboard in the session itself, so an open that named no session would land THERE.
    store.getState().focusLeaf(findLeafOfItem(store.getState().layout!, "i-lead")!.id);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "New tab" })).getByRole("menuitem", { name: new RegExp(`^${row}`) }));
    await waitFor(() => expect(api.calls).toContain(call));
    await waitFor(() => expect(store.getState().items.find((i) => i.id === side(store).itemId)?.kind).toBe(kind));
    expect(store.getState().focusedLeafId).toBe(side(store).id);
  });

  it("leaves the terminal out while Settings docks it to the session's foot — the session's bar has it then", async () => {
    await mount(ITEMS, { [TERMINALS_DOCK_KEY]: "bottom" });
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const menu = within(await screen.findByRole("menu", { name: "New tab" }));
    expect(menu.queryByRole("menuitem", { name: /^Terminal/ })).toBeNull();
    expect(menu.getByRole("menuitem", { name: /^Simulator/ })).toBeInTheDocument();
  });

  it("adds a blank tab for the session the keyboard is in, whichever session's tab is showing", async () => {
    // THE MUTANT: a + that adds to the session whose tab is showing. The keyboard is in ANOTHER session
    // here, and a new tab is the focused pane's session's.
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
    // On screen, in Other's run — ahead of Lead's, since Other's pane is read first.
    const fresh = side(store).itemId!;
    expect(side(store).tabs).toEqual([fresh, "i-br", "i-kid"]);
    expect(tabOwner(side(store), fresh)).toBe("i-other");
    expect(store.getState().items.find((i) => i.id === fresh)?.kind).toBe("browser");
  });

  it("with the keyboard in the panel, a new tab goes after the one showing, as a browser's does", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "New tab" })).getAllByRole("menuitem")[0]!);
    await waitFor(() => expect(side(store).tabs).toHaveLength(3));
    const fresh = side(store).itemId!;
    expect(side(store).tabs).toEqual(["i-br", fresh, "i-kid"]);
  });

  it("fills the host with this pane on New tab in full view", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "New tab" })).getAllByRole("menuitem")[1]!);
    await waitFor(() => expect(store.getState().view!.zoomedLeafId).toBe(side(store).id));
  });
});

describe("a strip with more tabs than room", () => {
  /** jsdom lays nothing out, so the strip's metrics are stated: the four numbers the dissolve reads. */
  const overflowing = (el: HTMLElement, scrollWidth: number, clientWidth: number) => {
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
  };
  const ends = (el: HTMLElement) => (el.dataset.dissolveX ?? "").split(" ").filter(Boolean);

  it("dissolves at the end that has more of it, and only there", async () => {
    // THE MUTANT: the strip as it was, a scroller nobody dissolves — a hard cut through a title.
    await mount();
    const tabs = screen.getByRole("tablist", { name: "Tabs" });
    act(() => { overflowing(tabs, 900, 300); tabs.dispatchEvent(new Event("scroll")); });
    expect(ends(tabs)).toEqual(["end"]);
    act(() => { tabs.scrollLeft = 300; tabs.dispatchEvent(new Event("scroll")); });
    expect(ends(tabs)).toEqual(["start", "end"]);
    act(() => { tabs.scrollLeft = 600; tabs.dispatchEvent(new Event("scroll")); });
    expect(ends(tabs)).toEqual(["start"]);
    // The + is beside the scroller, never in it, so the mask cannot reach it.
    expect(tabs.contains(screen.getByRole("button", { name: "New tab" }))).toBe(false);
  });

  it("dissolves nowhere while every tab fits", async () => {
    await mount();
    const tabs = screen.getByRole("tablist", { name: "Tabs" });
    act(() => { overflowing(tabs, 300, 300); tabs.dispatchEvent(new Event("scroll")); });
    expect(ends(tabs)).toEqual([]);
  });

  it("brings the tab showing clear of the dissolve when another is chosen", async () => {
    // THE MUTANT: leave the strip where it was. A tab chosen from the sidebar — or opened by an agent
    // past the end — would be the selected one, half under the fade or off the edge altogether.
    const { store, rerender } = await mount();
    const tabs = screen.getByRole("tablist", { name: "Tabs" });
    tabs.style.setProperty("--fade-w", "28px");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      // The strip is 300px across; the tab after the browser sits wholly past its end until scrolled.
      const at = this === tabs ? { left: 0, width: 300 }
        : this.classList.contains("pane-tab") && this.textContent?.includes("Agent: apply") ? { left: 420 - tabs.scrollLeft, width: 160 }
          : { left: 0, width: 0 };
      return { ...at, x: at.left, y: 0, top: 0, height: 28, right: at.left + at.width, bottom: 28, toJSON: () => ({}) } as DOMRect;
    });
    await store.getState().openItem("i-kid", side(store).id);
    rerender();
    // Its right edge lands where the dissolve starts, not under it: 420 + 160 - (300 - 28).
    expect(tabs.scrollLeft).toBe(308);
  });
});

describe("every tab's glyph", () => {
  it("is drawn at one size, whatever kind of thing the tab is", async () => {
    /* The owner's report: the documents and device tabs wore smaller marks than the session's. Every
       kind a side pane holds is a tab here, so a size picked per kind — or a glyph drawn by something
       other than the one size the strip asks for — fails by name. */
    const kinds = [
      item("i-term", "s1", { kind: "terminal", refId: "t1", title: "Terminal" }),
      item("i-docs", "s1", { kind: "documents", refId: "d1", title: "Documents · realm" }),
      item("i-sim", "s1", { kind: "simulator", refId: "m1", title: "iPhone 17 Pro" }),
      item("i-mac", "s1", { kind: "machine", refId: "v1", title: "Ubuntu" }),
      item("i-agents", "s1", { kind: "agents", refId: "lead", title: "Agents" }),
    ];
    const { store, rerender } = await mount([...ITEMS, ...kinds]);
    for (const k of kinds) await store.getState().openInSidePane("lead", k.id);
    // The browser in front again: only the tab showing mounts its pane, and this test is about the strip.
    await store.getState().openItem("i-br", side(store).id);
    rerender();
    const glyphs = strip().getAllByRole("tab").map((t) => {
      const g = t.firstElementChild as HTMLElement;
      // A terminal's glyph is its program's mark (ProgramMark): a square of the one size that holds
      // the shell's glyph and an agent's tile stacked, sized inline rather than by attribute.
      const kind = g.classList.contains("program-mark") ? "program-mark" : g.tagName.toLowerCase();
      const px = (attr: string | null, css: string) => attr ?? (css.endsWith("px") ? css.slice(0, -2) : null);
      return `${t.textContent}: ${kind} ${px(g.getAttribute("width"), g.style.width)}×${px(g.getAttribute("height"), g.style.height)}`;
    });
    expect(glyphs).toHaveLength(2 + kinds.length);
    // The glyph is the label's first child, which is what the stylesheet's `> svg` holds to its width.
    for (const line of glyphs) expect(line, line).toMatch(/: (svg|program-mark) 14×14$/);
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
    expect(within(bar).queryByRole("button", { name: "Summary and files for Agent: apply" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Pane menu for Agent: apply" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Summary and files/ })).toBeInTheDocument();
  });

  it("names the tab's close as a tab's, on ⌘W — a session in a strip is a tab, not a pane to unsplit", async () => {
    const { store, rerender } = await mount();
    await store.getState().openItem("i-kid", side(store).id);
    rerender();
    const bar = document.querySelector<HTMLElement>(`[data-leaf-id="${side(store).id}"] .panel-bar`)!;
    fireEvent.click(within(bar).getByRole("button", { name: "Pane menu for Agent: apply" }));
    const row = await screen.findByRole("menuitem", { name: /^Close tab/ });
    expect(row.querySelector(".menu-kbd")?.textContent).toBe("⌘W");
    expect(screen.queryByRole("menuitem", { name: /Remove from split/ })).toBeNull();
  });
});
