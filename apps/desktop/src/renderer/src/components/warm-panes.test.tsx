import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { sessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { Main } from "../App";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";
import { nextWarmPanes, WARM_SESSIONS } from "./warm-panes";

const all = () => true;

describe("nextWarmPanes", () => {
  it("keeps the one showing and the ones before it, and lets the oldest go past the cap", () => {
    let w = nextWarmPanes(undefined, "a", all);
    for (const id of ["b", "c", "d", "e"]) w = nextWarmPanes(w, id, all);
    expect(w.recent).toEqual(["b", "c", "d", "e"]);
    expect(w.recent).toHaveLength(WARM_SESSIONS);
  });

  it("never reorders what stays mounted, since a moved node loses its scroll", () => {
    let w = nextWarmPanes(undefined, "a", all);
    w = nextWarmPanes(w, "b", all);
    w = nextWarmPanes(w, "c", all);
    w = nextWarmPanes(w, "a", all);
    expect(w.order).toEqual(["a", "b", "c"]);
    expect(w.recent).toEqual(["b", "c", "a"]);
  });

  it("drops an item it may not keep, but always mounts the one showing", () => {
    let w = nextWarmPanes(undefined, "a", all);
    w = nextWarmPanes(w, "b", all);
    w = nextWarmPanes(w, "term", (id) => id !== "a");
    expect(w.order).toEqual(["b", "term"]);
  });
});

const said = (sessionId: string, text: string): StoredSessionEvent[] => [
  { seq: 1, sessionId, event: sessionEvent("user_message", { text: `Asked in ${text}`, attachments: [] }) },
  { seq: 2, sessionId, event: sessionEvent("assistant_text", { messageId: `m-${sessionId}`, text: `Answered in ${text}` }) },
];

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { vi.unstubAllGlobals(); });

async function mount() {
  const api = fakeApi({
    items: { s1: [item("ia", "s1", { kind: "session", refId: "a", title: "Alpha" }), item("ib", "s1", { kind: "session", refId: "b", title: "Bravo" })] },
    sessions: [session("a", "s1", { status: "idle" }), session("b", "s1", { status: "idle" })],
    sessionEvents: { a: said("a", "Alpha"), b: said("b", "Bravo") },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Main /></StoreContext.Provider>);
  return { store, api, ...r };
}

const shownPane = () => document.querySelector<HTMLElement>(".pane-slot:not([hidden]) .session-pane");

describe("switching back to a session the pane showed", () => {
  it("shows the tree it kept, at once, and reads nothing", async () => {
    const { store, api } = await mount();
    await act(async () => { await store.getState().revealSession("a", "s1"); });
    await waitFor(() => expect(shownPane()?.textContent).toContain("Answered in Alpha"));
    const alpha = shownPane();
    await act(async () => { await store.getState().revealSession("b", "s1"); });
    await waitFor(() => expect(shownPane()?.textContent).toContain("Answered in Bravo"));
    // Alpha's pane is still in the document, hidden behind Bravo's.
    expect(alpha?.isConnected).toBe(true);
    expect(alpha?.closest(".pane-slot")?.hasAttribute("hidden")).toBe(true);

    // Let Bravo's own reads land, then count only what going back to Alpha asks for.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const from = api.calls.length;
    // THE MUTANT: key the slots so a switch remounts (or drop the kept slots). Alpha's pane is then a
    // new node, built from nothing, and opening it reads its log again.
    act(() => { void store.getState().revealSession("a", "s1"); });
    // Drawn in the same commit as the click, before any read could have come back.
    expect(shownPane()).toBe(alpha);
    expect(shownPane()?.textContent).toContain("Answered in Alpha");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const reads = api.calls.slice(from).filter((c) => /^(sessionEvents|sessionEventsBefore|getSession|sessionStreaming)\b/.test(c));
    expect(reads).toEqual([]);
  });

  it("draws a reply that arrives while its session is hidden, and shows it on going back", async () => {
    const { store } = await mount();
    await act(async () => { await store.getState().revealSession("a", "s1"); });
    await waitFor(() => expect(shownPane()?.textContent).toContain("Answered in Alpha"));
    const alpha = shownPane();
    await act(async () => { await store.getState().revealSession("b", "s1"); });
    await waitFor(() => expect(shownPane()?.textContent).toContain("Answered in Bravo"));

    act(() => store.getState().applySessionEvent({ seq: 3, sessionId: "a", event: sessionEvent("assistant_text", { messageId: "m-a2", text: "Streamed while hidden" }), ephemeral: false }));
    expect(alpha?.closest(".pane-slot")?.hasAttribute("hidden")).toBe(true);
    expect(alpha?.textContent).toContain("Streamed while hidden");

    act(() => { void store.getState().revealSession("a", "s1"); });
    expect(shownPane()).toBe(alpha);
  });

  it("mounts no more than WARM_SESSIONS session panes in a leaf", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const api = fakeApi({
      items: { s1: ids.map((id) => item(`i${id}`, "s1", { kind: "session", refId: id, title: id })) },
      sessions: ids.map((id) => session(id, "s1", { status: "idle" })),
      sessionEvents: Object.fromEntries(ids.map((id) => [id, said(id, id)])),
    });
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><Main /></StoreContext.Provider>);
    for (const id of ids) {
      await act(async () => { await store.getState().revealSession(id, "s1"); });
      await waitFor(() => expect(shownPane()?.textContent).toContain(`Answered in ${id}`));
    }
    expect(document.querySelectorAll(".session-pane")).toHaveLength(WARM_SESSIONS);
  });
});
