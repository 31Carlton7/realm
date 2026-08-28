import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, renderHook, act } from "@testing-library/react";
import { CommandPalette, matchScore, relTime, usePaletteHotkey } from "./CommandPalette";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";

async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(over); const store = createAppStore(api); await store.getState().boot(); act(() => store.setState({ paletteOpen: true }));
  render(<StoreContext.Provider value={store}><CommandPalette /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("listAllItems")); // palette refreshes cross-space items on open
  return { store, api };
}

const options = () => screen.getAllByRole("option").map((o) => o.textContent);
const input = () => screen.getByRole("combobox");

describe("matchScore (subsequence + boosts)", () => {
  it("is a subsequence matcher: scattered letters match, missing or out-of-order letters do not", () => {
    expect(matchScore("ntl", "New terminal")).not.toBeNull();
    expect(matchScore("nz", "New terminal")).toBeNull();
    expect(matchScore("tn", "not")).toBeNull(); // order matters — not a bag of chars ("nt" would match)
    expect(matchScore("", "anything")).toBe(0);
    expect(matchScore("TERM", "New terminal")).not.toBeNull(); // case-insensitive
  });
  it("ranks word-start hits above buried ones: 'nt' prefers New terminal to Open Terminal", () => {
    expect(matchScore("nt", "New terminal")!).toBeGreaterThan(matchScore("nt", "Open Terminal…")!);
  });
  it("boosts a whole-query prefix", () => {
    expect(matchScore("new", "New terminal")!).toBeGreaterThan(matchScore("new", "Renew things")!);
  });
});

describe("relTime", () => {
  it("formats compact ages", () => {
    const now = 1_000_000_000_000;
    expect(relTime(now - 30_000, now)).toBe("now");
    expect(relTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relTime(now - 2 * 3_600_000, now)).toBe("2h");
    expect(relTime(now - 3 * 86_400_000, now)).toBe("3d");
  });
});

describe("CommandPalette", () => {
  it("lists items from ALL spaces, other-space rows hinted with their space name, and opening one switches space", async () => {
    const { store } = await mount({ items: {
      s1: [item("i1", "s1", { title: "Terminal" })],
      s2: [item("i2", "s2", { title: "Homework notes", kind: "session", refId: "se2" })],
    } });
    expect(store.getState().activeSpaceId).toBe("s1");
    const row = screen.getByRole("option", { name: /Homework notes/ });
    expect(row.textContent).toContain("Homework ·"); // space-name hint disambiguates (V-F4)
    fireEvent.click(row);
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    await waitFor(() => {
      const l = store.getState().layout!;
      expect(l.type === "leaf" && l.itemId).toBe("i2"); // opened into the fresh space's layout
    });
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("sorts a space's items by updatedAt desc (recency), open items of the active space first with a quadrant glyph", async () => {
    // Insertion order deliberately disagrees with recency (Middle before Newest) so a sort that
    // ignores updatedAt dies here instead of passing by accident.
    const { store } = await mount({ items: { s1: [
      item("old", "s1", { title: "Oldest", updatedAt: 100 }),
      item("mid", "s1", { title: "Middle", updatedAt: 200 }),
      item("new", "s1", { title: "Newest", updatedAt: 300 }),
    ] } });
    act(() => store.setState({ layout: { type: "split", id: "r", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "old" }, { type: "leaf", id: "L2", itemId: null },
    ] }, focusedLeafId: "L1" }));
    const labels = options();
    const at = (t: string) => labels.findIndex((x) => x?.startsWith(t));
    expect(at("Oldest")).toBe(0);                       // open section leads despite lowest updatedAt
    expect(at("Newest")).toBeLessThan(at("Middle"));    // recency inside the space group
    expect(at("Middle")).toBeLessThan(at("New terminal"));
    const byLabel = (t: string) => screen.getAllByRole("option").find((o) => o.querySelector(".palette-label")?.textContent === t)!;
    expect(byLabel("Oldest").querySelector(".item-glyph")).toBeInTheDocument();
    expect(byLabel("Newest").querySelector(".item-glyph")).toBeNull();
  });

  it("renders faint section headers — Open / space names / Actions / Theme — only while the query is empty", async () => {
    const { store } = await mount({ items: {
      s1: [item("i1", "s1", { title: "Terminal" }), item("i2", "s1", { title: "Notes" })],
      s2: [item("i3", "s2", { title: "Elsewhere" })],
    } });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));
    const secs = () => Array.from(document.querySelectorAll(".palette-sec")).map((el) => el.textContent);
    expect(secs()).toEqual(["Open", "Versed", "Homework", "Actions", "Theme"]);
    fireEvent.change(input(), { target: { value: "e" } });
    expect(secs()).toEqual([]); // filtered view is a flat ranked list
  });

  it("query ranking is score-ordered: 'nt' puts New terminal above an item titled Open Terminal…", async () => {
    await mount({ items: { s1: [item("i1", "s1", { title: "Open Terminal…" })] } });
    fireEvent.change(input(), { target: { value: "nt" } });
    const labels = options();
    const newTerm = labels.findIndex((x) => x?.startsWith("New terminal"));
    const openTerm = labels.findIndex((x) => x?.startsWith("Open Terminal…"));
    expect(newTerm).toBeGreaterThanOrEqual(0);
    expect(openTerm).toBeGreaterThanOrEqual(0);
    expect(newTerm).toBeLessThan(openTerm);
  });

  it("one-shot 'New Claude session' with no remembered config opens the sheet preselected to claude", async () => {
    const { store } = await mount();
    fireEvent.change(input(), { target: { value: "new claude" } });
    fireEvent.click(screen.getByRole("option", { name: /New Claude session/ }));
    expect(store.getState().sheet).toEqual({ kind: "new-session", agentKind: "claude" });
    expect(store.getState().paletteOpen).toBe(false);
  });

  it("one-shot creation reuses lastSessionConfig once the sheet has submitted for that agent", async () => {
    const { store } = await mount();
    // Simulate a prior sheet submission: the store records the agent's options.
    await act(() => store.getState().newSession({ agentKind: "claude", projectId: null, model: "claude-opus-5", permissionMode: "acceptEdits" }));
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.change(input(), { target: { value: "new claude" } });
    fireEvent.click(screen.getByRole("option", { name: /New Claude session/ }));
    await waitFor(() => {
      const created = Object.values(store.getState().sessions).filter((s) => s.agentKind === "claude");
      expect(created).toHaveLength(2);
      expect(created[1]).toMatchObject({ model: "claude-opus-5", permissionMode: "acceptEdits" });
    });
    expect(store.getState().sheet).toBeNull(); // no sheet round-trip
  });

  it("newSessionQuick drops a remembered projectId when quick-creating from a different space (projects are space-scoped)", async () => {
    const { store, api } = await mount({ projects: { s1: [{ id: "pr1", spaceId: "s1", name: "repo", rootPath: "/r", defaultBranch: "main", createdAt: 0, updatedAt: 0 }] } });
    await act(() => store.getState().newSession({ agentKind: "claude", projectId: "pr1", model: null }));
    await act(() => store.getState().selectSpace("s2"));
    await act(() => store.getState().newSessionQuick("claude"));
    const inS2 = api.data.sessions.find((s) => s.spaceId === "s2");
    expect(inS2).toBeDefined();
    expect(inS2!.projectId).toBeNull();
  });

  it("Close pane / Rename entries exist only with a focused non-empty leaf; Rename arms renamingItemId", async () => {
    const { store } = await mount();
    expect(screen.queryByRole("option", { name: /Close pane/ })).toBeNull(); // layout is empty
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));
    fireEvent.click(screen.getByRole("option", { name: /Rename/ }));
    expect(store.getState().renamingItemId).toBe("i1");
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.click(screen.getByRole("option", { name: /Close pane/ }));
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "leaf" && l.itemId).toBeNull(); });
  });

  it("Interrupt running session appears only while the focused pane's session is running", async () => {
    const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
    const { store, api } = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1", sessionStatus: { se1: "idle" } }));
    expect(screen.queryByRole("option", { name: /Interrupt running session/ })).toBeNull();
    act(() => store.setState({ sessionStatus: { se1: "running" } }));
    fireEvent.click(screen.getByRole("option", { name: /Interrupt running session/ }));
    await waitFor(() => expect(api.calls).toContain("interrupt:se1"));
  });

  it("'Respond to pending permission' appears only with a waiting session and jumps across spaces to it", async () => {
    const it2 = item("i2", "s2", { kind: "session", refId: "se2", title: "Waiting there" });
    const { store } = await mount({ items: { s2: [it2] }, sessions: [session("se2", "s2", { status: "idle" })] });
    expect(store.getState().activeSpaceId).toBe("s1");
    expect(screen.queryByRole("option", { name: /Respond to pending permission/ })).toBeNull();
    act(() => store.getState().applySessionStatus("se2", "waiting_permission"));
    fireEvent.click(screen.getByRole("option", { name: /Respond to pending permission/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    await waitFor(() => {
      const l = store.getState().layout!;
      expect(l.type === "leaf" && l.itemId).toBe("i2"); // the waiting session's item, opened + focused
    });
  });

  it("honest placeholder: the input says Search…, and actions still run from the keyboard", async () => {
    const { store } = await mount();
    expect(screen.getByPlaceholderText("Search…")).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "theme: dark" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(store.getState().themePref).toBe("dark"));
  });

  it("space switching and layout presets still work", async () => {
    const { store } = await mount();
    fireEvent.change(input(), { target: { value: "switch to home" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    act(() => store.setState({ paletteOpen: true }));
    fireEvent.change(input(), { target: { value: "layout: 3 col" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => {
      const l = store.getState().layout;
      expect(l?.type === "split" && l.dir === "row" && l.children.length).toBe(3);
    });
  });

  it("⌘K toggles the palette (still guarded by sheets)", () => {
    const store = createAppStore(fakeApi());
    renderHook(() => usePaletteHotkey(store));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(store.getState().paletteOpen).toBe(true);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(store.getState().paletteOpen).toBe(false);
    store.getState().openSheet({ kind: "new-space" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(store.getState().paletteOpen).toBe(false); // ignored while a sheet is open
  });
});
