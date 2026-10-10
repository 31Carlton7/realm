import { describe, expect, it } from "vitest";
import { PANE_DIVIDER, PANE_MIN } from "@realm/contracts";
import { SETTING_DEFAULT_MODELS, SETTING_LAST_MODELS, createAppStore } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";

/* The most recent model used is the default for the next session (backlog 2026-10-08, item 1): the
   model of the last message SENT, per agent kind, is what ⌘N, the split, the worktree session and a
   new space's first session start on — provided the harness still offers it. */

const OPUS = "claude-opus-5-5";

/** Session se1 (Claude, on `model`) open in space s1, and booted. */
async function setup({ model = OPUS as string | null, settings = {} as Record<string, unknown> } = {}) {
  const api = fakeApi({
    items: { s1: [item("i1", "s1", { kind: "session", title: "A", refId: "se1" })] },
    sessions: [session("se1", "s1", { agentKind: "claude", model })],
    settings: { "ui.lastAgentKind": "claude", ...settings },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i1");
  /** The session `createSession` made last. */
  const made = () => api.data.sessions[api.data.sessions.length - 1]!;
  return { api, store, made };
}

describe("the last model sent on is the next session's default", () => {
  it("a send on Opus 5.5 makes ⌘N create the next Claude session on Opus 5.5", async () => {
    // THE MUTANT: newSessionInstant creating with no model — the adapter default, Fable, every time.
    const { api, store, made } = await setup();
    await store.getState().sendMessage("se1", "hi");
    expect(store.getState().lastModels).toEqual({ claude: OPUS });
    expect(api.data.settings[SETTING_LAST_MODELS]).toEqual({ claude: OPUS });
    await store.getState().newSessionInstant();
    expect(made()).toMatchObject({ agentKind: "claude", model: OPUS });
  });

  it("picking a model without sending leaves the default alone", async () => {
    // THE MUTANT: recording at pick time (`setSessionOptions`) — an abandoned pick becomes the default.
    const { api, store, made } = await setup({ model: null });
    await store.getState().setSessionOptions("se1", { model: OPUS });
    await store.getState().newSessionInstant();
    expect(made().model).toBeNull();
    expect(api.data.settings[SETTING_LAST_MODELS]).toBeUndefined();
  });

  it("a send on the default is remembered as the default", async () => {
    // THE MUTANT: skipping null — a send on a session left on its default would keep Opus as the next.
    const { store, made } = await setup({ model: null, settings: { [SETTING_LAST_MODELS]: { claude: OPUS } } });
    await store.getState().sendMessage("se1", "hi");
    expect(store.getState().lastModels).toEqual({ claude: null });
    await store.getState().newSessionInstant();
    expect(made().model).toBeNull();
  });

  it("is per agent kind: after a Claude send on Opus, a Codex ⌘N starts on Codex's own default", async () => {
    // THE MUTANT: one global model string — Codex would be handed a Claude id.
    const { store, made } = await setup();
    await store.getState().sendMessage("se1", "hi");
    store.setState({ lastAgentKind: "codex" });
    await store.getState().newSessionInstant();
    expect(made()).toMatchObject({ agentKind: "codex", model: null });
  });

  it("a remembered model the harness no longer lists falls back to its default", async () => {
    // THE MUTANT: no `usableModel` — the session would be made on an id the CLI rejects at first send.
    const { store, made } = await setup({ settings: { [SETTING_LAST_MODELS]: { claude: "claude-retired-9" } } });
    expect(store.getState().lastModels).toEqual({ claude: "claude-retired-9" });
    await store.getState().newSessionInstant();
    expect(made().model).toBeNull();
  });

  it("boot reads `ui.lastModels`; a value of another shape reads as nothing remembered", async () => {
    // THE MUTANT: no parse — a stored string would be indexed as though it were the map.
    expect((await setup({ settings: { [SETTING_LAST_MODELS]: { claude: OPUS, codex: null } } })).store.getState().lastModels).toEqual({ claude: OPUS, codex: null });
    expect((await setup({ settings: { [SETTING_LAST_MODELS]: "claude-opus-5-5" } })).store.getState().lastModels).toEqual({});
    expect((await setup({ settings: { [SETTING_LAST_MODELS]: { claude: 5, nope: OPUS, codex: "gpt-6-luna" } } })).store.getState().lastModels).toEqual({ codex: "gpt-6-luna" });
  });

  it("a rejected settings write does not fail the send", async () => {
    // THE MUTANT: awaiting the persist inside the send.
    const { api, store } = await setup();
    api.setSetting = async () => { throw new Error("disk full"); };
    await expect(store.getState().sendMessage("se1", "hi")).resolves.toBeUndefined();
    expect(store.getState().lastModels).toEqual({ claude: OPUS });
  });

  it("a quick-chat send is not remembered", async () => {
    // THE MUTANT: recording every send — the quick chat's throwaway model would become the default.
    const { store } = await setup();
    store.setState({ quickChat: { sessionId: "se1" } });
    await store.getState().sendMessage("se1", "hi");
    expect(store.getState().lastModels).toEqual({});
  });

  it("a dispatched draft is a send, and is remembered", async () => {
    const { store } = await setup();
    store.getState().setDraft("se1", "go");
    await store.getState().dispatchDraft("se1");
    expect(store.getState().lastModels).toEqual({ claude: OPUS });
  });

  it("Split right, a session in a new worktree, and a new space's first session start on it too", async () => {
    // THE MUTANT: a create path left on the bare agent kind.
    const { store, made } = await setup({ settings: { [SETTING_LAST_MODELS]: { claude: OPUS } } });
    store.setState({ viewRoom: { width: 4 * PANE_MIN.width + 3 * PANE_DIVIDER, height: PANE_MIN.height } });
    await store.getState().splitNewSession("row");
    expect(made().model).toBe(OPUS);
    await store.getState().newSessionInWorktree();
    expect(made().model).toBe(OPUS);
    await store.getState().createSpace({ name: "New", icon: "folder", profileId: "p1" });
    expect(made()).toMatchObject({ agentKind: "claude", model: OPUS });
  });

  it("a session in a new worktree of a repository starts on it", async () => {
    // THE MUTANT: the worktree branch of newSessionInWorktree left on the bare agent kind.
    const api = fakeApi({
      items: { s1: [] },
      environments: { s1: [{ id: "envA", spaceId: "s1", path: "/tmp/envA", branch: "main", kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 }] },
      gitInfo: { "/tmp/envA": { branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 } },
      settings: { "ui.lastAgentKind": "claude", [SETTING_LAST_MODELS]: { claude: OPUS } },
    });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().newSessionInWorktree(null, "s1");
    expect(api.calls).toContain("createWorktree:s1");
    expect(api.data.sessions.at(-1)).toMatchObject({ agentKind: "claude", model: OPUS });
  });
});

describe("a model chosen for new sessions outranks the one last sent on", () => {
  const SONNET = "claude-sonnet-5";
  const chose = (models: Record<string, unknown>, more: Record<string, unknown> = {}) => setup({ settings: { [SETTING_DEFAULT_MODELS]: models, ...more } });

  it("starts ⌘N on the chosen model after a send on another one", async () => {
    const { store, made } = await chose({ claude: SONNET });
    await store.getState().sendMessage("se1", "hi");
    expect(store.getState().lastModels).toEqual({ claude: OPUS });
    await store.getState().newSessionInstant();
    expect(made()).toMatchObject({ agentKind: "claude", model: SONNET });
  });

  it("is not moved by a send, which still moves what is remembered", async () => {
    const { api, store } = await chose({ claude: SONNET });
    await store.getState().sendMessage("se1", "hi");
    expect(store.getState().defaultModels).toEqual({ claude: SONNET });
    expect(api.data.settings[SETTING_DEFAULT_MODELS]).toEqual({ claude: SONNET });
    expect(api.data.settings[SETTING_LAST_MODELS]).toEqual({ claude: OPUS });
  });

  it("goes back to the model last sent on once the choice is taken back", async () => {
    const { api, store, made } = await chose({ claude: SONNET }, { [SETTING_LAST_MODELS]: { claude: OPUS } });
    await store.getState().setDefaultModel("claude", null);
    expect(store.getState().defaultModels).toEqual({});
    expect(api.data.settings[SETTING_DEFAULT_MODELS]).toEqual({});
    await store.getState().newSessionInstant();
    expect(made().model).toBe(OPUS);
  });

  it("is per agent kind: a choice for Claude leaves a Codex session on what Codex was last sent on", async () => {
    const { store, made } = await chose({ claude: SONNET }, { [SETTING_LAST_MODELS]: { codex: "gpt-6-luna" } });
    store.setState({ lastAgentKind: "codex" });
    await store.getState().newSessionInstant();
    expect(made()).toMatchObject({ agentKind: "codex", model: "gpt-6-luna" });
  });

  it("passes over a chosen model the harness no longer lists, and keeps the choice", async () => {
    const { store, made } = await chose({ claude: "claude-retired-9" }, { [SETTING_LAST_MODELS]: { claude: OPUS } });
    await store.getState().newSessionInstant();
    expect(made().model).toBe(OPUS);
    expect(store.getState().defaultModels).toEqual({ claude: "claude-retired-9" });
  });

  it("starts Split right, a session in a new worktree, and a new space's first session on it too", async () => {
    const { store, made } = await chose({ claude: SONNET }, { [SETTING_LAST_MODELS]: { claude: OPUS } });
    store.setState({ viewRoom: { width: 4 * PANE_MIN.width + 3 * PANE_DIVIDER, height: PANE_MIN.height } });
    await store.getState().splitNewSession("row");
    expect(made().model).toBe(SONNET);
    await store.getState().newSessionInWorktree();
    expect(made().model).toBe(SONNET);
    await store.getState().createSpace({ name: "New", icon: "folder", profileId: "p1" });
    expect(made()).toMatchObject({ agentKind: "claude", model: SONNET });
  });

  it("reads `sessions.defaultModels` at boot, and a value that is no choice as none made", async () => {
    expect((await chose({ claude: SONNET, codex: "gpt-6-luna" })).store.getState().defaultModels).toEqual({ claude: SONNET, codex: "gpt-6-luna" });
    expect((await chose({ claude: null, codex: "", nope: SONNET, "acp:cursor": 5, "acp:goose": "   " })).store.getState().defaultModels).toEqual({});
    expect((await setup({ settings: { [SETTING_DEFAULT_MODELS]: SONNET } })).store.getState().defaultModels).toEqual({});
    expect((await setup()).store.getState().defaultModels).toEqual({});
  });

  it("is read at boot from the key spelled sessions.defaultModels", async () => {
    expect((await setup({ settings: { "sessions.defaultModels": { claude: SONNET } } })).store.getState().defaultModels).toEqual({ claude: SONNET });
  });

  it("writes a choice into what is stored now, so one made in another window for another agent is kept", async () => {
    const { api, store } = await chose({ claude: SONNET });
    api.data.settings[SETTING_DEFAULT_MODELS] = { claude: SONNET, codex: "gpt-6-luna" };
    await store.getState().setDefaultModel("claude", OPUS);
    expect(api.data.settings[SETTING_DEFAULT_MODELS]).toEqual({ claude: OPUS, codex: "gpt-6-luna" });
    expect(store.getState().defaultModels).toEqual({ claude: OPUS, codex: "gpt-6-luna" });
  });

  it("writes choices and nothing else, so an entry stored as no choice is not carried into the next write", async () => {
    const { api, store } = await chose({ claude: SONNET });
    api.data.settings[SETTING_DEFAULT_MODELS] = { claude: SONNET, codex: null, "acp:cursor": "" };
    await store.getState().setDefaultModel("claude", OPUS);
    expect(api.data.settings[SETTING_DEFAULT_MODELS]).toEqual({ claude: OPUS });
  });

  it("drops a choice taken back in another window when asked again", async () => {
    const { api, store } = await chose({ claude: SONNET, codex: "gpt-6-luna" });
    api.data.settings[SETTING_DEFAULT_MODELS] = { claude: SONNET, codex: null };
    await store.getState().refreshDefaultModels();
    expect(store.getState().defaultModels).toEqual({ claude: SONNET });
  });

  it("passes over a chosen model that the agent's live list has dropped", async () => {
    const { store, made } = await chose({ codex: "gpt-4-retired" }, { "ui.lastAgentKind": "codex", [SETTING_LAST_MODELS]: { codex: "gpt-6-luna" } });
    store.setState({ agentProbe: [{ kind: "codex", available: true, version: "1", loggedIn: true, reason: null,
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true }, { id: "gpt-6-luna", label: "GPT-6-Luna" }] }] });
    await store.getState().newSessionInstant();
    expect(made()).toMatchObject({ agentKind: "codex", model: "gpt-6-luna" });
  });

  it("reads a choice made in another window when asked again", async () => {
    const { api, store, made } = await chose({});
    api.data.settings[SETTING_DEFAULT_MODELS] = { claude: SONNET };
    await store.getState().newSessionInstant();
    expect(made().model).toBeNull();
    await store.getState().refreshDefaultModels();
    await store.getState().newSessionInstant();
    expect(made().model).toBe(SONNET);
  });

  it("keeps the old choice when the write is refused", async () => {
    const { api, store } = await chose({ claude: SONNET });
    api.setSetting = async () => { throw new Error("disk full"); };
    await expect(store.getState().setDefaultModel("claude", OPUS)).rejects.toThrow("disk full");
    expect(store.getState().defaultModels).toEqual({ claude: SONNET });
  });
});

describe("a session started on a named agent, with no model named", () => {
  const SONNET = "claude-sonnet-5";
  const LUNA = "gpt-6-luna";

  it("starts on the model chosen for that agent, though another agent was used last", async () => {
    const { store, made } = await setup({ settings: { [SETTING_DEFAULT_MODELS]: { codex: LUNA, claude: SONNET } } });
    await store.getState().newSession({ agentKind: "codex" });
    expect(made()).toMatchObject({ agentKind: "codex", model: LUNA });
  });

  it("starts on the model last sent on with that agent where none is chosen", async () => {
    const { store, made } = await setup({ settings: { [SETTING_LAST_MODELS]: { codex: LUNA, claude: OPUS } } });
    await store.getState().newSession({ agentKind: "codex" });
    expect(made()).toMatchObject({ agentKind: "codex", model: LUNA });
    await store.getState().newSession({ agentKind: "claude" });
    expect(made()).toMatchObject({ agentKind: "claude", model: OPUS });
  });

  it("starts on the harness's own default where the agent has neither", async () => {
    const { store, made } = await setup({ settings: { [SETTING_DEFAULT_MODELS]: { claude: SONNET }, [SETTING_LAST_MODELS]: { claude: OPUS } } });
    await store.getState().newSession({ agentKind: "codex" });
    expect(made()).toMatchObject({ agentKind: "codex", model: null });
  });

  it("leaves a session asked for on the harness's own default on it", async () => {
    const { store, made } = await setup({ settings: { [SETTING_DEFAULT_MODELS]: { claude: SONNET }, [SETTING_LAST_MODELS]: { claude: OPUS } } });
    await store.getState().newSession({ agentKind: "claude", model: null });
    expect(made().model).toBeNull();
  });

  it("leaves a named model as it was named", async () => {
    const { store, made } = await setup({ settings: { [SETTING_DEFAULT_MODELS]: { claude: SONNET } } });
    await store.getState().newSession({ agentKind: "claude", model: "claude-haiku-4-5" });
    expect(made().model).toBe("claude-haiku-4-5");
  });
});
