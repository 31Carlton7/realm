import { describe, expect, it } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AGENT_META, SELECTABLE_AGENT_KINDS, SPACE_COLORS, allItems } from "@realm/contracts";
import { AppShell, Main } from "../App";
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

describe("first-run onboarding", () => {
  const radio = (label: string) => screen.getByRole("radio", { name: new RegExp(label) });
  const start = () => screen.getByRole("button", { name: "Start" });
  const card = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) }).closest(".agent-card") as HTMLElement;
  const codexInstall = { kind: "codex" as const, installed: false, version: null, binPath: null, provenance: "unknown" as const,
    latest: null, updateAvailable: false, action: "install" as const, command: "npm install -g @openai/codex", refusal: null };
  const codexSignedOut = { kind: "codex" as const, available: true, version: "codex-cli 0.154.0", loggedIn: false, reason: "not logged in" };

  it("leads with Claude and Codex as cards, each saying what it needs, and folds the other agents behind one line", async () => {
    /* A first run is a decision, not an inventory. THE mutants: thirteen equal rows again, or a card
       that says a state without offering the thing that state needs. */
    await mountFresh({ cliStatus: [codexInstall] });
    await waitFor(() => expect(within(card("Claude")).getByText("Signed in")).toBeInTheDocument());
    expect(within(card("Codex")).getByRole("button", { name: "Install Codex" })).toBeInTheDocument();
    // The rest are one line until asked for — and every one is there when they are.
    expect(screen.queryByText(AGENT_META["acp:cursor"].label)).toBeNull();
    const more = screen.getByRole("button", { name: /more agents/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    for (const k of SELECTABLE_AGENT_KINDS) expect(screen.getAllByText(new RegExp(`^${k === "claude" ? "Claude" : k === "codex" ? "Codex" : AGENT_META[k].label}$`)).length).toBeGreaterThan(0);
    expect(within(radio("Cursor").closest("label") as HTMLElement).getByText("Signed out")).toBeInTheDocument();
  });

  it("says each card is checking until the probe lands, with the app's spinner on it", async () => {
    const api = fakeApi({ spaces: [], items: {} });
    api.delays["probeAgents"] = 50;
    api.delays["probeAgent"] = 50;
    const store = createAppStore(api); await store.getState().boot();
    const { container } = render(<StoreContext.Provider value={store}><Onboarding /></StoreContext.Provider>);
    expect(within(card("Claude")).getByText("Checking…")).toBeInTheDocument();
    expect(within(card("Codex")).getByText("Checking…")).toBeInTheDocument();
    const step = () => container.querySelector("fieldset.onboarding-step");
    expect(step()).toHaveAttribute("aria-busy", "true");
    // THE mutant: a spinner that outlives the answer, so the page claims to be working forever.
    await waitFor(() => expect(screen.queryAllByText("Checking…")).toHaveLength(0));
    expect(step()).not.toHaveAttribute("aria-busy");
  });

  it("answers the two cards from their own probes, while the whole probe is still out", async () => {
    /* `agents.probe` answers when every adapter has, and an ACP agent's model listing can take half a
       minute. THE mutants: cards that wait for it, or a fold that reads every agent the lead probes
       did not mention as "Not installed" before anyone has asked about them. */
    const api = fakeApi({ spaces: [], items: {}, agentProbe: [claudeReady, codexMissing, cursorSignedOut] });
    api.delays["probeAgents"] = 1500; // longer than waitFor's own second, so only the lead probes can answer in it
    const store = createAppStore(api); await store.getState().boot();
    const { container } = render(<StoreContext.Provider value={store}><Onboarding /></StoreContext.Provider>);
    await waitFor(() => expect(within(card("Claude")).getByText("Signed in")).toBeInTheDocument());
    expect(api.calls).toEqual(expect.arrayContaining(["probeAgent:claude", "probeAgent:codex"]));
    expect(store.getState().agentsProbed).toBe(false);
    expect(container.querySelector("fieldset.onboarding-step")).not.toHaveAttribute("aria-busy");
    fireEvent.click(screen.getByRole("button", { name: /more agents/ }));
    const cursor = () => radio("Cursor").closest("label") as HTMLElement;
    expect(within(cursor()).queryByText("Not installed")).toBeNull();
    expect(within(cursor()).queryByText("Signed out")).toBeNull();
    // …and the fold fills in when the whole probe lands.
    await waitFor(() => expect(within(cursor()).getByText("Signed out")).toBeInTheDocument(), { timeout: 4000 });
  });

  it("Sign in with ChatGPT runs Codex's own sign-in with no space, and the card follows it to Signed in", async () => {
    /* THE mutants: a sign-in that needs a space first (there is none on a first run), or a card that
       forgets the sign-in once the page is up. */
    const { api, store } = await mountFresh({ agentProbe: [claudeReady, codexSignedOut] });
    const signIn = await within(card("Codex")).findByRole("button", { name: "Sign in with ChatGPT" });
    fireEvent.click(signIn);
    await waitFor(() => expect(api.calls).toContain("agentSignInStart:codex"));
    expect(api.calls.some((c) => c.startsWith("startSignIn:"))).toBe(false);
    // Signing in to Codex means Codex.
    expect(radio("Codex")).toBeChecked();
    expect(await within(card("Codex")).findByText("Finish signing in in your browser.")).toBeInTheDocument();
    expect(within(card("Codex")).getByRole("button", { name: "Open the page again" })).toBeInTheDocument();
    // The CLI asks for the page's code: a field for it, and Enter sends it rather than starting.
    act(() => store.getState().applyAgentSignIn({ id: "si-codex", kind: "codex", state: "code", url: null, detail: null }));
    const code = within(card("Codex")).getByRole("textbox", { name: "Code from Codex's sign-in page" });
    fireEvent.change(code, { target: { value: "ABCD-1234" } });
    fireEvent.keyDown(code, { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain("agentSignInCode:si-codex:9"));
    expect(api.calls.some((c) => c.startsWith("createSpace"))).toBe(false);
    // Signed in: the card says so, and Codex is probed again at once — Codex alone.
    api.data.agentProbe = [claudeReady, { ...codexSignedOut, loggedIn: true }];
    const asked = api.calls.filter((c) => c === "probeAgent:codex").length;
    act(() => store.getState().applyAgentSignIn({ id: "si-codex", kind: "codex", state: "done", url: null, detail: null }));
    expect(within(card("Codex")).getByText("Signed in")).toBeInTheDocument();
    await waitFor(() => expect(store.getState().agentProbe.find((r) => r.kind === "codex")?.loggedIn).toBe(true));
    expect(api.calls.filter((c) => c === "probeAgent:codex").length).toBe(asked + 1);
  });

  it("a sign-in that did not finish says so and offers it again; Cancel stops one in flight", async () => {
    const { api, store } = await mountFresh({ agentProbe: [claudeReady, codexSignedOut] });
    fireEvent.click(await within(card("Codex")).findByRole("button", { name: "Sign in with ChatGPT" }));
    fireEvent.click(await within(card("Codex")).findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.calls).toContain("agentSignInCancel:si-codex"));
    act(() => store.getState().applyAgentSignIn({ id: "si-codex", kind: "codex", state: "failed", url: null, detail: "Error: network" }));
    expect(within(card("Codex")).getByText(/didn't finish/)).toBeInTheDocument();
    expect(within(card("Codex")).getByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
  });

  it("Install runs the install the server offers, and the card shows it running", async () => {
    const { api, store } = await mountFresh({ cliStatus: [codexInstall] });
    fireEvent.click(await within(card("Codex")).findByRole("button", { name: "Install Codex" }));
    await waitFor(() => expect(store.getState().cliJobs.codex?.state).toBe("running"));
    expect(api.calls.some((c) => c.startsWith("runCli:codex:install") || c === "runCli:codex:install")).toBe(true);
    expect(within(card("Codex")).getByText("Installing Codex…")).toBeInTheDocument();
    expect(radio("Codex")).toBeChecked();
  });

  it("where the install cannot run here, says why — and points at what provides npm", async () => {
    // THE mutant: an Install button that can only fail with `spawn npm ENOENT`.
    await mountFresh({ cliStatus: [{ ...codexInstall, action: "none", command: null,
      refusal: "Codex installs with npm, which comes with Node.js — and Node.js isn't on this Mac yet." }] });
    expect(await within(card("Codex")).findByText(/Node.js isn't on this Mac yet/)).toBeInTheDocument();
    expect(within(card("Codex")).queryByRole("button", { name: "Install Codex" })).toBeNull();
    expect(within(card("Codex")).getByRole("button", { name: "Get Node.js" })).toBeInTheDocument();
  });

  it("defaults to the first agent that actually works, and persists an explicit pick to ui.lastAgentKind", async () => {
    const { api, store } = await mountFresh();
    await waitFor(() => expect(within(card("Claude")).getByText("Signed in")).toBeInTheDocument());
    expect(radio("Claude")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /more agents/ }));
    fireEvent.click(radio("Cursor"));
    await waitFor(() => expect(store.getState().lastAgentKind).toBe("acp:cursor"));
    expect(api.data.settings[SETTING_LAST_AGENT]).toBe("acp:cursor");
  });

  it("honours a remembered agent from the fold — and opens the fold, so the pick is never hidden", async () => {
    const { store } = await mountFresh({ settings: { [SETTING_LAST_AGENT]: "acp:cursor" } });
    await waitFor(() => expect(store.getState().lastAgentKind).toBe("acp:cursor"));
    expect(radio("Cursor")).toBeChecked();
    expect(screen.getByRole("button", { name: /Fewer agents/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("says beside Start what it will do — and what the session will ask for when the agent is not ready", async () => {
    await mountFresh({ cliStatus: [codexInstall] });
    await waitFor(() => expect(screen.getByText("Starts a Claude session in Home.")).toBeInTheDocument());
    fireEvent.click(radio("Codex"));
    expect(screen.getByText("Codex isn't installed yet — install it above, or from the session.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(radio("Claude"));
    expect(screen.getByText("Starts a Claude session in Versed.")).toBeInTheDocument();
  });

  it("takes the whole window while it is up: no rail and no sidebar, whose buttons need a space", async () => {
    const api = fakeApi({ spaces: [], items: {} });
    const store = createAppStore(api); await store.getState().boot();
    const { container } = render(<StoreContext.Provider value={store}><AppShell /></StoreContext.Provider>);
    expect(container.querySelector(".app")).toHaveAttribute("data-first-run");
    expect(screen.getByText("Welcome to Realm")).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText("Signed in")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Versed" } });
    fireEvent.click(start());
    await waitFor(() => expect(store.getState().spaces).toHaveLength(1));
    expect(api.data.settings[SETTING_LAST_AGENT]).toBe("claude");
    expect(store.getState().spaces[0]!.profileId).toBe(store.getState().profiles[0]!.id);
  });

  it("asks in two numbered steps, the agent first in the source", async () => {
    /* The mutant is ordering them the other way to make the focused field come first, which reads as
       a form with an afterthought rather than the page's order of questions. */
    const { container } = await mountFresh();
    const steps = [...container.querySelectorAll("fieldset.onboarding-step > legend")].map((l) => l.textContent);
    expect(steps).toEqual(["1Choose your agent", "2Name your space"]);
  });

  it("carries the space's icon and colour, which the first screen used to decide silently", async () => {
    // `completeOnboarding` wrote a folder glyph and the first palette colour straight into
    // `createSpace`. The identity was always being chosen; it just was not being shown or asked.
    const { store } = await mountFresh();
    await waitFor(() => expect(screen.getByText("Signed in")).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText("Signed in")).toBeInTheDocument());
    fireEvent.click(radio("Codex"));
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
