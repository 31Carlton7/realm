import { describe, expect, it } from "vitest";
import { PANE_DIVIDER, PANE_MIN } from "@realm/contracts";
import { SETTING_LAST_MODELS, createAppStore } from "./store";
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
