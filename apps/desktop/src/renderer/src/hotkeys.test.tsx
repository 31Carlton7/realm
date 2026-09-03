import { describe, expect, it } from "vitest";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import type { Layout } from "@realm/contracts";
import { useGlobalHotkeys } from "./hotkeys";
import { createAppStore, neighborLeafId } from "./state/store";
import { fakeApi, item, session, space } from "./state/store.test-fakes";

/** Real store + the hook, driven by window KeyboardEvents — exactly what production runs. */
async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  renderHook(() => useGlobalHotkeys(store));
  return { api, store };
}

const key = (init: KeyboardEventInit & { key: string }, target: Element | Window = window) =>
  fireEvent.keyDown(target, init);
/** Let any promise chain a binding kicked off settle, so "nothing happened" assertions are real. */
const tick = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

//    root (row)
//   ┌─────┬─────┐
//   │ L1  │ col │      L2 above L3 in the right column.
//   │     ├─────┤
//   │     │ L3  │
const grid: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
  { type: "leaf", id: "L1", itemId: "A" },
  { type: "split", id: "c1", dir: "col", sizes: [50, 50], children: [
    { type: "leaf", id: "L2", itemId: "B" },
    { type: "leaf", id: "L3", itemId: null },
  ] },
] };

describe("neighborLeafId (structural approximation)", () => {
  it("moves across a row split, descending to the near edge of the sibling subtree", () => {
    expect(neighborLeafId(grid, "L1", "right")).toBe("L2"); // cross-axis descent takes the first child
    expect(neighborLeafId(grid, "L2", "left")).toBe("L1");
    expect(neighborLeafId(grid, "L3", "left")).toBe("L1");
  });
  it("moves within a col split and no-ops at the edges", () => {
    expect(neighborLeafId(grid, "L2", "down")).toBe("L3");
    expect(neighborLeafId(grid, "L3", "up")).toBe("L2");
    expect(neighborLeafId(grid, "L1", "left")).toBeNull();
    expect(neighborLeafId(grid, "L1", "up")).toBeNull();
    expect(neighborLeafId(grid, "L1", "down")).toBeNull();
    expect(neighborLeafId(grid, "L2", "right")).toBeNull();
  });
  it("moving left into a subtree lands on its far-right leaf (near edge of travel)", () => {
    const l: Layout = { type: "split", id: "r", dir: "row", sizes: [50, 50], children: [
      { type: "split", id: "s", dir: "row", sizes: [50, 50], children: [
        { type: "leaf", id: "a", itemId: null }, { type: "leaf", id: "b", itemId: null },
      ] },
      { type: "leaf", id: "c", itemId: null },
    ] };
    expect(neighborLeafId(l, "c", "left")).toBe("b");
    expect(neighborLeafId(l, "a", "right")).toBe("b");
  });
});

describe("useGlobalHotkeys", () => {
  it("⌘1…⌘9 select the nth space; out-of-range is a no-op", async () => {
    const { store } = await mount();
    key({ key: "2", metaKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    key({ key: "9", metaKey: true }); // only two spaces exist
    expect(store.getState().activeSpaceId).toBe("s2");
    key({ key: "1", metaKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s1"));
  });

  it("⌘1…⌘9 number the ACTIVE PROFILE's spaces, so the digits match the strip on screen", async () => {
    // s1, s2 in Work; s3 in School. Indexing the whole home would make ⌘3 reach into another profile
    // and would renumber Work's spaces every time School gained one.
    const { store } = await mount({
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p2", "Thesis")],
      items: { s1: [], s2: [], s3: [] },
    });
    key({ key: "3", metaKey: true });
    await tick();
    expect(store.getState().activeSpaceId).toBe("s1"); // Work has no third space
    key({ key: "2", metaKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    // Inside School, ⌘1 is School's only space — not the home's first.
    await act(async () => { await store.getState().selectSpace("s3"); });
    key({ key: "1", metaKey: true });
    await tick();
    expect(store.getState().activeSpaceId).toBe("s3");
  });

  it("⌃Tab / ⌃⇧Tab cycle spaces forward and back", async () => {
    const { store } = await mount();
    key({ key: "Tab", ctrlKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    key({ key: "Tab", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s1"));
  });

  it("⌘\\ splits right, ⌘⇧\\ (reported as |) splits down", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));
    key({ key: "\\", metaKey: true });
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "split" && l.dir).toBe("row"); });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));
    key({ key: "|", metaKey: true, shiftKey: true });
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "split" && l.dir).toBe("col"); });
  });

  it("⌘⌥arrows move pane focus directionally; wrong direction stays put", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L1" }));
    key({ key: "ArrowRight", metaKey: true, altKey: true });
    expect(store.getState().focusedLeafId).toBe("L2");
    key({ key: "ArrowDown", metaKey: true, altKey: true });
    expect(store.getState().focusedLeafId).toBe("L3");
    key({ key: "ArrowUp", metaKey: true, altKey: true });
    expect(store.getState().focusedLeafId).toBe("L2");
    key({ key: "ArrowLeft", metaKey: true, altKey: true });
    expect(store.getState().focusedLeafId).toBe("L1");
    key({ key: "ArrowLeft", metaKey: true, altKey: true }); // edge: no neighbor
    expect(store.getState().focusedLeafId).toBe("L1");
  });

  it("⌘W closes the focused non-empty leaf's item from the layout (item survives) and always preventDefaults", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L1", items: [item("A", "s1"), item("B", "s1")] }));
    const e = key({ key: "w", metaKey: true });
    expect(e).toBe(false); // fireEvent returns false when defaultPrevented — the window never closes
    await waitFor(() => {
      const l = store.getState().layout!;
      expect(l.type === "split" && l.children[0]).toEqual({ type: "leaf", id: "L2", itemId: "B" });
    });
    expect(store.getState().items.map((i) => i.id)).toEqual(["A", "B"]); // layout-only, never deleted
  });

  it("⌘W on an empty focused leaf is a no-op (but still consumed)", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L3", items: [item("A", "s1"), item("B", "s1")] }));
    const e = key({ key: "w", metaKey: true });
    expect(e).toBe(false);
    expect(store.getState().layout).toEqual(grid);
  });

  it("⌘T opens a terminal; ⌘N creates a session immediately — no sheet, no questions (W3)", async () => {
    const { api, store } = await mount();
    key({ key: "t", metaKey: true });
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "terminal" && i.id !== "i1")).toBe(true));
    key({ key: "n", metaKey: true });
    await waitFor(() => expect(Object.keys(store.getState().sessions)).toHaveLength(1));
    expect(store.getState().sheet).toBeNull();
    // No remembered agent: Claude, and the session is open and focused in its own pane.
    expect(api.calls).toContain("createSession:claude");
    const se = Object.values(store.getState().sessions)[0]!;
    expect(store.getState().items.some((i) => i.kind === "session" && i.refId === se.id)).toBe(true);
  });

  it("⌘N reaches for the last-used agent, persisted across launches", async () => {
    const { api, store } = await mount();
    await act(() => store.getState().newSession({ agentKind: "codex" }));
    await waitFor(() => expect(api.data.settings["ui.lastAgentKind"]).toBe("codex"));
    key({ key: "n", metaKey: true });
    await waitFor(() => expect(api.calls.filter((c) => c === "createSession:codex")).toHaveLength(2));
    // A fresh store over the same settings still remembers — this is a setting, not session state.
    const next = createAppStore(api); await next.getState().boot();
    expect(next.getState().lastAgentKind).toBe("codex");
  });

  it("Esc interrupts the focused pane's session only while it is running", async () => {
    const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
    const { api, store } = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1", sessionStatus: { se1: "idle" } }));
    key({ key: "Escape" });
    expect(api.calls).not.toContain("interrupt:se1"); // idle: no interrupt
    act(() => store.setState({ sessionStatus: { se1: "running" } }));
    key({ key: "Escape" });
    await waitFor(() => expect(api.calls).toContain("interrupt:se1"));
  });

  it("Esc works from an editable target (the composer) too", async () => {
    const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
    const { api, store } = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1", sessionStatus: { se1: "running" } }));
    const ta = document.createElement("textarea"); document.body.appendChild(ta); ta.focus();
    key({ key: "Escape" }, ta);
    await waitFor(() => expect(api.calls).toContain("interrupt:se1"));
    ta.remove();
  });

  it("a focused terminal (xterm helper textarea) does NOT swallow global bindings: ⌘W closes, ⌘\\ splits", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L1", items: [item("A", "s1"), item("B", "s1")] }));
    // xterm's real focus target: a helper <textarea> nested inside the .xterm root element.
    const host = document.createElement("div"); host.className = "xterm";
    const ta = document.createElement("textarea"); ta.className = "xterm-helper-textarea";
    host.appendChild(ta); document.body.appendChild(host); ta.focus();
    key({ key: "w", metaKey: true }, ta);
    await waitFor(() => {
      const l = store.getState().layout!;
      expect(l.type === "split" && l.children[0]).toEqual({ type: "leaf", id: "L2", itemId: "B" }); // pane closed
    });
    key({ key: "\\", metaKey: true }, ta);
    await waitFor(() => {
      const l = store.getState().layout!;
      expect(l.type === "split" && l.children.some((c) => c.type === "split" && c.dir === "row")).toBe(true); // split fired
    });
    host.remove();
  });

  it("guard: bindings do nothing from an editable target (⌘W) or while a sheet or the palette is open (⌘1)", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L1", items: [item("A", "s1"), item("B", "s1")] }));
    const input = document.createElement("input"); document.body.appendChild(input); input.focus();
    const e = key({ key: "w", metaKey: true }, input);
    expect(e).toBe(false); // belt-and-braces: still consumed so Electron never sees it
    expect(store.getState().layout).toEqual(grid); // …but nothing closed
    input.remove();

    act(() => store.getState().openSheet({ kind: "new-space" }));
    key({ key: "2", metaKey: true });
    expect(store.getState().activeSpaceId).toBe("s1"); // sheet owns the keyboard
    act(() => store.setState({ sheet: null, paletteOpen: true }));
    key({ key: "2", metaKey: true });
    expect(store.getState().activeSpaceId).toBe("s1"); // palette owns the keyboard
  });

  it("an event a closer handler already consumed (defaultPrevented) is never re-handled", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L1", items: [item("A", "s1"), item("B", "s1")] }));
    const e = new KeyboardEvent("keydown", { key: "w", metaKey: true, cancelable: true, bubbles: true });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(store.getState().layout).toEqual(grid);
  });

  describe("⌘U — attach files to the focused session (Plan 12 W1)", () => {
    const focusedSession = async () => {
      const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
      const r = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")],
        pickFiles: [{ path: "/x/a.png", mime: "image/png", name: "a.png", size: 10 }] });
      act(() => r.store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1" }));
      return r;
    };

    it("opens the native picker exactly ONCE — the menu's ⌘U label is visual, this is the one binding", async () => {
      const { api, store } = await focusedSession();
      key({ key: "u", metaKey: true });
      await waitFor(() => expect(store.getState().pendingAttachments["se1"]).toHaveLength(1));
      expect(api.calls.filter((c) => c === "pickFiles")).toHaveLength(1); // double-firing is the named mutant
    });

    it("fires from the composer — an editable target, which the guard would otherwise swallow", async () => {
      const { api } = await focusedSession();
      const ta = document.createElement("textarea"); document.body.appendChild(ta); ta.focus();
      key({ key: "u", metaKey: true }, ta);
      await waitFor(() => expect(api.calls.filter((c) => c === "pickFiles")).toHaveLength(1));
      ta.remove();
    });

    it("does nothing when the focused pane is not a session", async () => {
      const { api, store } = await mount();
      act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1", items: [item("i1", "s1", { kind: "terminal" })] }));
      key({ key: "u", metaKey: true });
      await tick();
      expect(api.calls).not.toContain("pickFiles");
    });

    it("is still governed by the overlay guard: a sheet owns the keyboard", async () => {
      const { api, store } = await focusedSession();
      act(() => store.getState().openSheet({ kind: "new-space" }));
      key({ key: "u", metaKey: true });
      await tick();
      expect(api.calls).not.toContain("pickFiles");
    });
  });

  describe("⌘⇧↩ — dispatch the focused session's draft (Plan 13 W2)", () => {
    const focusedSession = async () => {
      const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
      const r = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
      act(() => r.store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1" }));
      act(() => r.store.getState().setDraft("se1", "go fix it"));
      return r;
    };

    it("fires FROM the composer: creates the dispatched session, sends the draft, keeps focus put", async () => {
      const { api, store } = await focusedSession();
      const ta = document.createElement("textarea"); document.body.appendChild(ta); ta.focus();
      key({ key: "Enter", metaKey: true, shiftKey: true }, ta);
      await waitFor(() => expect(api.sent).toHaveLength(1));
      expect(api.sent[0]!.text).toBe("go fix it");
      const created = api.data.sessions.find((s) => s.dispatchedBy?.kind === "user-dispatch");
      expect(created).toBeDefined();
      expect(api.sent[0]!.id).toBe(created!.id); // the draft went to the NEW session, not se1
      await waitFor(() => expect(store.getState().drafts["se1"]).toBe(""));
      expect(store.getState().focusedLeafId).toBe("L1"); // the focus-steal mutant
      ta.remove();
    });

    it("plain ⌘↩ is NOT dispatch — the chord requires shift", async () => {
      const { api } = await focusedSession();
      key({ key: "Enter", metaKey: true });
      await tick();
      expect(api.sent).toHaveLength(0);
      expect(api.data.sessions.some((s) => s.dispatchedBy !== null)).toBe(false);
    });

    it("an empty draft is a no-op — nothing created, nothing sent", async () => {
      const { api, store } = await focusedSession();
      act(() => store.getState().setDraft("se1", "   "));
      key({ key: "Enter", metaKey: true, shiftKey: true });
      await tick();
      expect(api.sent).toHaveLength(0);
      expect(api.data.sessions.some((s) => s.dispatchedBy !== null)).toBe(false);
    });
  });

  describe("⌘B — the sidebar", () => {
    it("toggles collapsed, then back, and persists each flip", async () => {
      const { api, store } = await mount();
      expect(store.getState().sidebarCollapsed).toBe(false);
      key({ key: "b", metaKey: true });
      await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(true));
      expect(api.calls).toContain("setSetting:ui.sidebarCollapsed=true");
      key({ key: "b", metaKey: true });
      await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(false));
      expect(api.calls).toContain("setSetting:ui.sidebarCollapsed=false");
    });

    it("does not fire from an editable target, so ⌘B still bolds in the composer", async () => {
      // The one binding decision worth a test: adding `inInputs: true` here would silently break
      // bold in the rich composer, and nothing else in the suite would notice.
      const { store } = await mount();
      const input = document.createElement("textarea");
      document.body.appendChild(input);
      key({ key: "b", metaKey: true }, input);
      await tick();
      expect(store.getState().sidebarCollapsed).toBe(false);
      input.remove();
    });

    it("is inert while the palette owns the keyboard", async () => {
      const { store } = await mount();
      act(() => store.getState().setPaletteOpen(true));
      key({ key: "b", metaKey: true });
      await tick();
      expect(store.getState().sidebarCollapsed).toBe(false);
    });
  });

  describe("⌘J — the focused session's terminal drawer (W4)", () => {
    const focusedSession = async () => {
      const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
      const r = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
      act(() => r.store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1" }));
      return r;
    };

    it("toggles the panel open, then shut", async () => {
      const { api, store } = await focusedSession();
      key({ key: "j", metaKey: true });
      await waitFor(() => expect(store.getState().terminalPanel["se1"]?.open).toBe(true));
      expect(api.calls).toContain("openSessionTerminal:se1");
      key({ key: "j", metaKey: true });
      await waitFor(() => expect(store.getState().terminalPanel["se1"]?.open).toBe(false));
    });

    it("fires from inside the terminal it opened — a focused xterm must not swallow its own toggle", async () => {
      const { store } = await focusedSession();
      const host = document.createElement("div"); host.className = "xterm";
      const ta = document.createElement("textarea"); ta.className = "xterm-helper-textarea";
      host.appendChild(ta); document.body.appendChild(ta.parentElement!); ta.focus();
      key({ key: "j", metaKey: true }, ta);
      await waitFor(() => expect(store.getState().terminalPanel["se1"]?.open).toBe(true));
      host.remove();
    });

    it("fires from the composer too — that is where the hands are", async () => {
      const { store } = await focusedSession();
      const ta = document.createElement("textarea"); document.body.appendChild(ta); ta.focus();
      key({ key: "j", metaKey: true }, ta);
      await waitFor(() => expect(store.getState().terminalPanel["se1"]?.open).toBe(true));
      ta.remove();
    });

    it("does nothing when the focused pane is not a session (and never spawns a pty)", async () => {
      const { api, store } = await mount();
      act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1", items: [item("i1", "s1", { kind: "terminal" })] }));
      key({ key: "j", metaKey: true });
      await tick();
      expect(store.getState().terminalPanel).toEqual({});
      expect(api.calls.some((c) => c.startsWith("openSessionTerminal"))).toBe(false);
    });

    it("is still governed by the overlay guard: a sheet owns the keyboard", async () => {
      const { store } = await focusedSession();
      act(() => store.getState().openSheet({ kind: "new-space" }));
      key({ key: "j", metaKey: true });
      await tick();
      expect(store.getState().terminalPanel["se1"]).toBeUndefined();
    });
  });

  it("⌘3 with three spaces reaches the third (index mapping, not offset)", async () => {
    const { store } = await mount({ spaces: [space("s1", "p1", "One"), space("s2", "p1", "Two"), space("s3", "p1", "Three")], items: {} });
    key({ key: "3", metaKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s3"));
  });
});
