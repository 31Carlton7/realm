import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AGENT_META, SELECTABLE_AGENT_KINDS, SPACE_COLORS, allItems } from "@realm/contracts";
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
  const radio = (label: string) => screen.getByRole("radio", { name: new RegExp(label) });
  const start = () => screen.getByRole("button", { name: "Start" });

  it("lists the agents it FOUND, ready first, and folds the rest behind one line", async () => {
    await mountFresh();
    await waitFor(() => expect(screen.getByText("2.0.1")).toBeInTheDocument());
    // Claude (ready) and Cursor (signed out) are found; Codex is not installed, and the ten other
    // kinds the fake never probed read as missing too — twelve equal rows was the old screen.
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(screen.queryByText("Codex")).toBeNull();
    const more = screen.getByRole("button", { name: /more not installed/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getAllByText("Not installed").length).toBeGreaterThan(0);
    for (const k of SELECTABLE_AGENT_KINDS) expect(screen.getByText(AGENT_META[k].label)).toBeInTheDocument();
  });

  it("says once that it is checking, rather than pinning 'Checking…' on every row", async () => {
    const api = fakeApi({ spaces: [], items: {} });
    api.delays["probeAgents"] = 50;
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}><Onboarding /></StoreContext.Provider>);
    expect(screen.getByText(/Checking which agents are installed/)).toBeInTheDocument();
    expect(screen.queryByText("Checking…")).toBeNull();
    // Every agent is listed plainly meanwhile — an empty list would read as "none found".
    for (const k of SELECTABLE_AGENT_KINDS) expect(screen.getByText(AGENT_META[k].label)).toBeInTheDocument();
  });

  it("shows every agent, with a hint, when none was found at all", async () => {
    await mountFresh({ agentProbe: [codexMissing] });
    await waitFor(() => expect(screen.getByText(/None of these is installed yet/)).toBeInTheDocument());
    for (const k of SELECTABLE_AGENT_KINDS) expect(screen.getByText(AGENT_META[k].label)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more not installed/ })).toBeNull();
  });

  it("defaults to the first agent that actually works, and persists an explicit pick to ui.lastAgentKind", async () => {
    const { api, store } = await mountFresh();
    await waitFor(() => expect(screen.getByText("2.0.1")).toBeInTheDocument());
    expect(radio("Claude")).toBeChecked();     // claude probes ready
    expect(radio("Cursor")).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /more not installed/ }));
    fireEvent.click(radio("Codex")); // unavailable agents stay pickable — the prompter's card explains
    await waitFor(() => expect(store.getState().lastAgentKind).toBe("codex"));
    expect(api.data.settings[SETTING_LAST_AGENT]).toBe("codex");
    expect(radio("Codex")).toBeChecked();
  });

  it("honours a remembered agent over the probe's first ready one", async () => {
    const { store } = await mountFresh({ settings: { [SETTING_LAST_AGENT]: "acp:cursor" } });
    await waitFor(() => expect(screen.getByText("2.0.1")).toBeInTheDocument());
    expect(store.getState().lastAgentKind).toBe("acp:cursor");
    expect(radio("Cursor")).toBeChecked();
  });

  it("is completable from the keyboard alone: the name field has focus, Enter creates the space", async () => {
    const { store } = await mountFresh();
    const name = screen.getByRole("textbox", { name: "Space name" });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "Versed" } });
    fireEvent.submit(name.closest("form")!);
    await waitFor(() => expect(store.getState().spaces.map((s) => s.name)).toEqual(["Versed"]));
    expect(store.getState().activeSpaceId).toBe(store.getState().spaces[0]!.id);
  });

  it("needs nothing typed: Start is live from the first frame and the space takes the default name", async () => {
    /* The old sheet disabled its button until a name was typed, so the shortest first run was
       "read twelve rows, invent a name, find the button under them". The mutant: gate Start on
       the field again, or submit an empty string, which the server refuses. */
    const { store } = await mountFresh();
    expect(start()).toBeEnabled();
    fireEvent.click(start());
    await waitFor(() => expect(store.getState().spaces.map((s) => s.name)).toEqual(["Home"]));
  });

  it("creating the first space also commits the chosen default agent", async () => {
    const { api, store } = await mountFresh();
    await waitFor(() => expect(screen.getByText("2.0.1")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(start());
    await waitFor(() => expect(store.getState().spaces).toHaveLength(1));
    expect(api.data.settings[SETTING_LAST_AGENT]).toBe("claude");
    expect(store.getState().spaces[0]!.profileId).toBe(store.getState().profiles[0]!.id);
  });

  it("puts the agent and the space in two labelled groups, agents first in the source", async () => {
    /* Reading order is left to right, and a grid that folds puts the columns back in SOURCE order —
       so the agent inventory has to come first in the DOM for the stacked case to read as the same
       screen. The mutant is ordering them the other way to make the focused field come first, which
       looks right at one width and inverts the screen at the other. */
    await mountFresh();
    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.querySelector("legend")?.textContent)).toEqual(["Agent", "Space"]);
  });

  it("carries the space's icon and colour, which the first screen used to decide silently", async () => {
    // `completeOnboarding` wrote a folder glyph and the first palette colour straight into
    // `createSpace`. The identity was always being chosen; it just was not being shown or asked.
    const { store } = await mountFresh();
    await waitFor(() => expect(screen.getByText("2.0.1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: `Color ${SPACE_COLORS[3]}` }));
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(start());
    await waitFor(() => expect(store.getState().spaces).toHaveLength(1));
    expect(store.getState().spaces[0]!.color).toBe(SPACE_COLORS[3]);
  });

  it("defaults the identity rather than leaving it blank, so Start works untouched", async () => {
    const { store } = await mountFresh();
    fireEvent.click(start());
    await waitFor(() => expect(store.getState().spaces).toHaveLength(1));
    expect(store.getState().spaces[0]!.color).toBe(SPACE_COLORS[0]);
    expect(store.getState().spaces[0]!.icon).toBe("folder");
  });

  it("marks exactly one colour as chosen", async () => {
    // A radiogroup where nothing is checked, or two things are, is a control that cannot say what it
    // will do — and this one has a default, so "nothing checked" would be a lie about the outcome.
    await mountFresh();
    const checked = screen.getAllByRole("radio", { name: /^Color / }).filter((b) => b.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute("aria-label", `Color ${SPACE_COLORS[0]}`);
  });

  it("finishing onboarding lands in a session, not the empty-state placeholder", async () => {
    const { api, store } = await mountFresh();
    fireEvent.click(start());
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("createSession"))).toHaveLength(1));
    // ...and it is open, so the first thing after onboarding is a prompter.
    expect(allItems(store.getState().layout!)).toHaveLength(1);
  });

  it("the session onboarding opens uses the agent just chosen", async () => {
    const { api } = await mountFresh();
    await waitFor(() => expect(screen.getByText("2.0.1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /more not installed/ }));
    fireEvent.click(radio(AGENT_META.codex.label));
    fireEvent.click(start());
    await waitFor(() => expect(api.calls).toContain("createSession:codex"));
  });

  describe("the folder", () => {
    it("chosen through the dialog becomes the space's first project, names the space, and the session opens in it", async () => {
      /* The step the old sheet never had: a session used to open in the empty folder Realm
         allocates, and the first act of every first run was hunting for "+ Add folder". */
      const { api, store } = await mountFresh();
      fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
      await waitFor(() => expect(screen.getByText("/tmp/picked-repo")).toBeInTheDocument());
      expect(screen.getByRole("textbox", { name: "Space name" })).toHaveAttribute("placeholder", "picked-repo");
      fireEvent.click(start());
      await waitFor(() => expect(store.getState().spaces.map((s) => s.name)).toEqual(["picked-repo"]));
      const sid = store.getState().spaces[0]!.id;
      expect(api.data.projects[sid]?.map((p) => p.rootPath)).toEqual(["/tmp/picked-repo"]);
      const created = api.calls.find((c) => c.startsWith("createSession"));
      expect(created).toBeDefined();
      expect(store.getState().sessions[Object.keys(store.getState().sessions)[0]!]?.projectId).toBe(api.data.projects[sid]![0]!.id);
    });

    it("dropped from the Finder is taken as the folder, and can be removed again", async () => {
      const { api, store } = await mountFresh();
      const zone = screen.getByRole("button", { name: "Choose folder…" }).parentElement!;
      const dir = Object.assign(new File([], "realm", { type: "" }), { path: "/Users/me/code/realm" });
      fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [dir], dropEffect: "none" } });
      expect(screen.getByText("/Users/me/code/realm")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Remove folder" }));
      expect(screen.queryByText("/Users/me/code/realm")).toBeNull();
      fireEvent.click(start());
      await waitFor(() => expect(store.getState().spaces).toHaveLength(1));
      expect(api.data.projects[store.getState().spaces[0]!.id] ?? []).toEqual([]);
    });

    it("a typed name beats the folder's", async () => {
      const { store } = await mountFresh();
      fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
      await waitFor(() => expect(screen.getByText("/tmp/picked-repo")).toBeInTheDocument());
      fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
      fireEvent.click(start());
      await waitFor(() => expect(store.getState().spaces.map((s) => s.name)).toEqual(["Versed"]));
    });
  });

  it("with no profile at all it makes one rather than dead-ending", async () => {
    const { store } = await mountFresh({ profiles: [] });
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(start());
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
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
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
