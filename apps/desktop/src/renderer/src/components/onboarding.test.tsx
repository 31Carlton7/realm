import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AGENT_META, SELECTABLE_AGENT_KINDS, allItems } from "@realm/contracts";
import { Main } from "../App";
import { Onboarding } from "./Onboarding";
import { StoreContext, SETTING_LAST_AGENT, createAppStore } from "../state/store";
import { fakeApi, item, space, type FakeData } from "../state/store.test-fakes";

const claudeReady = { kind: "claude" as const, available: true, version: "2.0.1", loggedIn: true, reason: null };
const codexMissing = { kind: "codex" as const, available: false, version: null, loggedIn: null, reason: "spawn codex ENOENT" };
const cursorSignedOut = { kind: "acp:cursor" as const, available: true, version: "1.0", loggedIn: false, reason: "not logged in" };

/** A store on an empty home: no spaces, no items — exactly what a first launch looks like. */
async function mountFresh(overrides: FakeData = {}) {
  const api = fakeApi({ spaces: [], items: {}, agentProbe: [claudeReady, codexMissing, cursorSignedOut], ...overrides });
  const store = createAppStore(api); await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Onboarding /></StoreContext.Provider>);
  return { api, store, ...r };
}

describe("first-run onboarding (W4)", () => {
  it("lists every offerable CLI with its detected status", async () => {
    await mountFresh();
    await waitFor(() => expect(screen.getByText(/Ready · 2\.0\.1/)).toBeInTheDocument());
    for (const k of SELECTABLE_AGENT_KINDS) expect(screen.getByText(AGENT_META[k].label)).toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument(); // codex
    expect(screen.getByText("Signed out")).toBeInTheDocument();    // cursor
  });

  it("says 'Checking…' rather than guessing before the probe lands", async () => {
    const api = fakeApi({ spaces: [], items: {} });
    api.delays["probeAgents"] = 50;
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}><Onboarding /></StoreContext.Provider>);
    expect(screen.getAllByText("Checking…")).toHaveLength(SELECTABLE_AGENT_KINDS.length);
  });

  it("defaults to the first agent that actually works, and persists an explicit pick to ui.lastAgentKind", async () => {
    const { api, store } = await mountFresh();
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
    const radio = (label: string) => screen.getByRole("radio", { name: new RegExp(label) });
    expect(radio("Claude")).toBeChecked();     // claude probes ready
    expect(radio("Codex")).not.toBeChecked();

    fireEvent.click(radio("Codex")); // unavailable agents stay pickable — the prompter's card explains
    await waitFor(() => expect(store.getState().lastAgentKind).toBe("codex"));
    expect(api.data.settings[SETTING_LAST_AGENT]).toBe("codex");
    expect(radio("Codex")).toBeChecked();
  });

  it("honours a remembered agent over the probe's first ready one", async () => {
    const { store } = await mountFresh({ settings: { [SETTING_LAST_AGENT]: "acp:cursor" } });
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
    expect(store.getState().lastAgentKind).toBe("acp:cursor");
    expect(screen.getByRole("radio", { name: /Cursor/ })).toBeChecked();
  });

  it("is completable from the keyboard alone: the name field has focus, Enter creates the space", async () => {
    const { store } = await mountFresh();
    const name = screen.getByRole("textbox", { name: "Space name" });
    expect(document.activeElement).toBe(name);
    // Native radios, so the agent list is one tab stop with arrow-key movement — no roving handlers.
    for (const k of SELECTABLE_AGENT_KINDS) expect(screen.getByRole("radio", { name: new RegExp(AGENT_META[k].label) })).toBeInTheDocument();
    fireEvent.change(name, { target: { value: "Versed" } });
    fireEvent.submit(name.closest("form")!);
    await waitFor(() => expect(store.getState().spaces.map((s) => s.name)).toEqual(["Versed"]));
    expect(store.getState().activeSpaceId).toBe(store.getState().spaces[0]!.id);
  });

  it("creating the first space also commits the chosen default agent", async () => {
    const { api, store } = await mountFresh();
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() => expect(store.getState().spaces).toHaveLength(1));
    expect(api.data.settings[SETTING_LAST_AGENT]).toBe("claude");
    expect(store.getState().spaces[0]!.profileId).toBe(store.getState().profiles[0]!.id);
  });

  it("finishing onboarding lands in a session, not the empty-state placeholder", async () => {
    const { api, store } = await mountFresh();
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("createSession"))).toHaveLength(1));
    // ...and it is open, so the first thing after onboarding is a prompter.
    expect(allItems(store.getState().layout!)).toHaveLength(1);
  });

  it("the session onboarding opens uses the agent just chosen", async () => {
    const { api } = await mountFresh();
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(AGENT_META.codex.label) }));
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() => expect(api.calls).toContain("createSession:codex"));
  });

  it("an empty name can't create a space", async () => {
    const { store } = await mountFresh();
    expect(screen.getByRole("button", { name: "Create space" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "   " } });
    fireEvent.submit(screen.getByRole("textbox", { name: "Space name" }).closest("form")!);
    expect(store.getState().spaces).toHaveLength(0);
  });

  it("with no profile at all it makes one rather than dead-ending", async () => {
    const { store } = await mountFresh({ profiles: [] });
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() => expect(store.getState().spaces).toHaveLength(1));
    expect(store.getState().profiles.map((p) => p.name)).toEqual(["Personal"]);
  });
});

describe("when Main shows onboarding", () => {
  const mountMain = async (data: FakeData) => {
    const api = fakeApi(data);
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}><Main /></StoreContext.Provider>);
    return store;
  };

  it("replaces the bare 'Create a space' placeholder on an empty home", async () => {
    await mountMain({ spaces: [], items: {} });
    expect(screen.getByText("Welcome to Realm")).toBeInTheDocument();
    expect(screen.queryByText(/Create a space with the \+/)).toBeNull();
  });

  it("never appears once a space exists", async () => {
    await mountMain({ items: { s1: [item("i1", "s1", { title: "Terminal" })] } });
    expect(screen.queryByText("Welcome to Realm")).toBeNull();
  });

  it("does not come back after the first space is created", async () => {
    const store = await mountMain({ spaces: [], items: {} });
    expect(screen.getByText("Welcome to Realm")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() => expect(screen.queryByText("Welcome to Realm")).toBeNull());
    expect(store.getState().spaces).toHaveLength(1);
  });

  it("holds off until boot finishes, so a populated home never flashes it", async () => {
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed")], items: {} });
    api.delays["listSpaces"] = 20;
    const store = createAppStore(api);
    const booting = store.getState().boot();
    render(<StoreContext.Provider value={store}><Main /></StoreContext.Provider>);
    // Mid-boot the store legitimately has zero spaces; `booted` is what keeps the sheet away.
    expect(screen.queryByText("Welcome to Realm")).toBeNull();
    await booting;
    await waitFor(() => expect(screen.queryByText("Welcome to Realm")).toBeNull());
  });
});
