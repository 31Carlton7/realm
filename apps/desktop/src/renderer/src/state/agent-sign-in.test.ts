import { describe, expect, it, vi } from "vitest";
import { sessionEvent, type AgentSignIn, type StoredSessionEvent } from "@realm/contracts";
import type { StoreApi } from "zustand";
import { createAppStore, type AgentProbe, type AppState, type LiveSessionEvent } from "./store";
import { claudeFolder, claudeRow, fakeApi, item, profile, session, space, type FakeApi, type FakeData } from "./store.test-fakes";

/**
 * The first run's space-less sign-ins, as the store keeps them: the latest per agent, moved by the
 * server's events and by each start's own answer, which can arrive in either order.
 */
const signIn = (over: Partial<AgentSignIn> & Pick<AgentSignIn, "id" | "state">): AgentSignIn =>
  ({ kind: "codex", url: null, detail: null, ...over });

async function fresh() {
  const api = fakeApi({ spaces: [], items: {} });
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

/** An agent whose row no Claude config folder decides. */
const codex: AgentProbe = { kind: "codex", available: true, version: "1.0", loggedIn: true, reason: null };

/**
 * A booted window on Work (p1), whose Claude config folder is signed in as one account, beside
 * Personal (p2), whose folder is signed in as another. Each profile has a space, and each space a
 * Claude session that holds no conversation yet: `se1` in Work's, `se2` in Personal's.
 */
async function twoAccounts(over: FakeData = {}) {
  const api = fakeApi({
    profiles: [profile("p1", "Work"), profile("p2", "Personal")],
    spaces: [space("s1", "p1", "Versed"), space("s2", "p2", "Thesis")],
    items: { s1: [item("i1", "s1", { kind: "session", refId: "se1" })], s2: [item("i2", "s2", { kind: "session", refId: "se2" })] },
    sessions: [session("se1", "s1", { agentKind: "claude" }), session("se2", "s2", { agentKind: "claude" })],
    agentProbe: [claudeRow("default@example.com"), codex],
    profileClaude: { p1: claudeRow("work@example.com", "/Users/u/.claude-work"), p2: claudeRow("me@example.com", "/Users/u/.claude-personal") },
    claudeDirs: { p1: claudeFolder("/Users/u/.claude-work"), p2: claudeFolder("/Users/u/.claude-personal") },
    ...over,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

/** The account on Claude's row in `agentProbe`, or null where the row names none. */
const emailOf = (store: StoreApi<AppState>): string | null =>
  store.getState().agentProbe.find((r) => r.kind === "claude")?.account?.email ?? null;

/** The asks the fake logged for one session's own Claude row, in the order they were made. */
const sessionAsks = (api: FakeApi, sessionId: string): string[] =>
  api.calls.filter((c) => c.startsWith("probeAgent:claude:") && c.endsWith(`:session:${sessionId}`));

/** One session's event as the server broadcasts it. */
const live = (sessionId: string, event: StoredSessionEvent["event"]): LiveSessionEvent => ({ seq: 9, sessionId, event, ephemeral: false });

describe("a first-run sign-in in the store", () => {

  it("does not let a start's own answer walk back the events that beat it here", async () => {
    // The server broadcasts "browser" before the start's reply is read: the reply's "starting" is older.
    const { store } = await fresh();
    store.getState().applyAgentSignIn(signIn({ id: "a", state: "code" }));
    store.getState().applyAgentSignIn(signIn({ id: "a", state: "starting" }));
    expect(store.getState().agentSignIns.codex?.state).toBe("code");
  });

  it("ignores a REPLACED sign-in's late cancellation, which says nothing about the new one", async () => {
    const { store } = await fresh();
    store.getState().applyAgentSignIn(signIn({ id: "b", state: "browser" }));
    store.getState().applyAgentSignIn(signIn({ id: "a", state: "cancelled" }));
    expect(store.getState().agentSignIns.codex).toMatchObject({ id: "b", state: "browser" });
    // …while the current one's own cancellation lands.
    store.getState().applyAgentSignIn(signIn({ id: "b", state: "cancelled" }));
    expect(store.getState().agentSignIns.codex?.state).toBe("cancelled");
  });

  it("probes that agent again the moment its sign-in is done, so every surface reads it signed in", async () => {
    // That agent alone: a whole forced probe waits on the slowest adapter, half a minute on a Mac
    // with an ACP agent whose model listing is slow, to say nothing about this one.
    const { api, store } = await fresh();
    const forced = api.calls.filter((c) => c === "probeAgents:true").length;
    store.getState().applyAgentSignIn(signIn({ id: "a", state: "done" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls).toContain("probeAgent:codex");
    expect(api.calls.filter((c) => c === "probeAgents:true").length).toBe(forced);
  });

  it("starts the sign-in for the profile the window shows, so it lands in that profile's Claude config folder", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().startAgentSignIn("claude");
    await store.getState().switchProfile("p2");
    await store.getState().startAgentSignIn("claude");
    expect(api.calls.filter((c) => c.startsWith("agentSignInStart:claude:profile:"))).toEqual(["agentSignInStart:claude:profile:p1", "agentSignInStart:claude:profile:p2"]);
  });

  it("starts the sign-in for the profile it is handed, which need not be the one the window shows", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().startAgentSignIn("claude", "p2");
    expect(api.calls.filter((c) => c.startsWith("agentSignInStart:claude:profile:"))).toEqual(["agentSignInStart:claude:profile:p2"]);
  });

  it("holds the folder that sign-in lands in, as the server states it", async () => {
    const { store } = await twoAccounts();
    await store.getState().startAgentSignIn("claude", "p2");
    expect(store.getState().agentSignIns.claude?.home).toBe("/Users/u/.claude-personal");
  });

  it("sends a code and a cancel for the sign-in it holds, and nothing when it holds none", async () => {
    const { api, store } = await fresh();
    await store.getState().sendAgentSignInCode("claude", "X");
    await store.getState().cancelAgentSignIn("claude");
    expect(api.calls.some((c) => c.startsWith("agentSignInCode") || c.startsWith("agentSignInCancel"))).toBe(false);
    store.getState().applyAgentSignIn(signIn({ id: "c1", kind: "claude", state: "code" }));
    await store.getState().sendAgentSignInCode("claude", "ABC");
    await store.getState().cancelAgentSignIn("claude");
    expect(api.calls).toContain("agentSignInCode:c1:3");
    expect(api.calls).toContain("agentSignInCancel:c1");
  });

  it("marks the sign-in it cancelled as cancelled once the server has answered, since the server reports nothing of one it is no longer running", async () => {
    const { store } = await fresh();
    store.getState().applyAgentSignIn(signIn({ id: "c1", kind: "claude", state: "code", url: "https://example.com/oauth/authorize" }));
    await store.getState().cancelAgentSignIn("claude");
    expect(store.getState().agentSignIns.claude).toEqual(signIn({ id: "c1", kind: "claude", state: "cancelled", url: "https://example.com/oauth/authorize" }));
  });

  it("leaves a sign-in as the server ended it where that ending landed while the cancel was on its way", async () => {
    const { api, store } = await fresh();
    store.getState().applyAgentSignIn(signIn({ id: "c1", kind: "claude", state: "code" }));
    api.agentSignInCancel = async () => { store.getState().applyAgentSignIn(signIn({ id: "c1", kind: "claude", state: "failed", detail: "Error: network" })); };
    await store.getState().cancelAgentSignIn("claude");
    expect(store.getState().agentSignIns.claude).toMatchObject({ id: "c1", state: "failed", detail: "Error: network" });
  });

  it("leaves a sign-in that took the place of the one it cancelled as it is", async () => {
    const { api, store } = await fresh();
    store.getState().applyAgentSignIn(signIn({ id: "c1", kind: "claude", state: "code" }));
    api.agentSignInCancel = async () => { store.getState().applyAgentSignIn(signIn({ id: "c2", kind: "claude", state: "browser" })); };
    await store.getState().cancelAgentSignIn("claude");
    expect(store.getState().agentSignIns.claude).toMatchObject({ id: "c2", state: "browser" });
  });

  it("still takes the ending the server reports for a sign-in after it has marked that sign-in cancelled", async () => {
    const { store } = await fresh();
    store.getState().applyAgentSignIn(signIn({ id: "c1", kind: "claude", state: "browser" }));
    await store.getState().cancelAgentSignIn("claude");
    store.getState().applyAgentSignIn(signIn({ id: "c1", kind: "claude", state: "failed", detail: "Error: network" }));
    expect(store.getState().agentSignIns.claude).toMatchObject({ state: "failed", detail: "Error: network" });
  });
});

describe("one agent's probe in the store", () => {
  const row = (kind: "claude" | "codex", loggedIn: boolean) => ({ kind, available: true, version: "1", loggedIn, reason: null });

  it("replaces that agent's row in place and leaves the rest as the whole probe said", async () => {
    const api = fakeApi({ spaces: [], items: {}, agentProbe: [row("claude", false), row("codex", false)] });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().probeAgents();
    api.data.agentProbe = [row("claude", true), row("codex", true)];
    await store.getState().probeAgent("claude");
    expect(store.getState().agentProbe.map((r) => [r.kind, r.loggedIn])).toEqual([["claude", true], ["codex", false]]);
  });

  it("adds a row before any whole probe has landed, without claiming the rest were probed", async () => {
    // A kind missing from the list reads as "not on this Mac" only once a whole probe says so.
    const api = fakeApi({ spaces: [], items: {}, agentProbe: [row("codex", true)] });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().probeAgent("codex");
    expect(store.getState().agentProbe).toEqual([row("codex", true)]);
    expect(store.getState().agentsProbed).toBe(false);
    await store.getState().probeAgents();
    expect(store.getState().agentsProbed).toBe(true);
  });

  it("keeps the list as it was for a kind the server has no adapter for", async () => {
    const api = fakeApi({ spaces: [], items: {}, agentProbe: [row("codex", true)] });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().probeAgent("claude");
    expect(store.getState().agentProbe).toEqual([]);
  });
});

describe("the probe, asked for the profile the window shows", () => {
  it("asks about the active profile's Claude config folder, forced or not", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeAgents();
    await store.getState().probeAgents(true);
    expect(api.calls.filter((c) => c.startsWith("probeAgents:plain:") || c.startsWith("probeAgents:forced:"))).toEqual(["probeAgents:plain:p1", "probeAgents:forced:p1"]);
  });

  it("holds the account of the folder that profile names", async () => {
    const { store } = await twoAccounts();
    await store.getState().probeAgents();
    expect(emailOf(store)).toBe("work@example.com");
  });

  it("asks for one agent's row for the active profile too, and afresh", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeAgent("claude");
    expect(api.calls).toContain("probeAgent:claude:forced:profile:p1");
    expect(emailOf(store)).toBe("work@example.com");
  });

  it("names no profile before one is the window's", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().probeAgents();
    await store.getState().probeAgent("fake");
    expect(api.calls).toEqual(["probeAgents:false", "probeAgent:fake"]);
  });

  it("never joins a call that is in flight for another profile", async () => {
    const { api, store } = await twoAccounts();
    api.delays["probeAgents"] = 10;
    const forWork = store.getState().probeAgents();
    store.setState({ activeProfileId: "p2" });
    const forPersonal = store.getState().probeAgents();
    await Promise.all([forWork, forPersonal]);
    expect(api.calls.filter((c) => c.startsWith("probeAgents:plain:"))).toEqual(["probeAgents:plain:p1", "probeAgents:plain:p2"]);
  });

  it("drops an answer that lands after the window has moved to another profile", async () => {
    const { api, store } = await twoAccounts();
    api.delays["probeAgents"] = 30;
    const late = store.getState().probeAgents();
    api.delays["probeAgents"] = 0;
    await store.getState().selectProfile("p2");
    await vi.waitFor(() => expect(emailOf(store)).toBe("me@example.com"));
    await late;
    expect(emailOf(store)).toBe("me@example.com");
  });

  it("drops one agent's row as well when it lands after the window has moved on", async () => {
    const { api, store } = await twoAccounts();
    api.delays["probeAgent"] = 30;
    const late = store.getState().probeAgent("claude");
    await store.getState().selectProfile("p2");
    await vi.waitFor(() => expect(emailOf(store)).toBe("me@example.com"));
    await late;
    expect(emailOf(store)).toBe("me@example.com");
  });

  it("is asked again for a profile whose probe before it failed", async () => {
    const { api, store } = await twoAccounts();
    const answering = api.probeAgents;
    api.probeAgents = () => Promise.reject(new Error("the server went away"));
    await expect(store.getState().probeAgents()).rejects.toThrow("the server went away");
    api.probeAgents = answering;
    await store.getState().probeAgents();
    expect(emailOf(store)).toBe("work@example.com");
  });

  it("still asks for Claude's own row, for the window's profile, once a Claude sign-in is done", async () => {
    const { api, store } = await twoAccounts();
    store.getState().applyAgentSignIn(signIn({ id: "a", kind: "claude", state: "done" }));
    expect(api.calls).toContain("probeAgent:claude:forced:profile:p1");
  });
});

describe("a session's own Claude row in the store", () => {
  it("is asked for by the session's name, from what the server last learned, and held", async () => {
    const { api, store } = await twoAccounts({ sessionClaude: { se1: claudeRow("began@example.com", "/Users/u/.claude-old") } });
    await store.getState().probeSessionClaude("se1");
    expect(sessionAsks(api, "se1")).toEqual(["probeAgent:claude:plain:session:se1"]);
    expect(store.getState().sessionClaude).toEqual({ se1: claudeRow("began@example.com", "/Users/u/.claude-old") });
  });

  it("is asked for afresh when the caller says so", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1", true);
    expect(sessionAsks(api, "se1")).toEqual(["probeAgent:claude:forced:session:se1"]);
  });

  it("is left out when the server has no row to give", async () => {
    const { store } = await twoAccounts({ agentProbe: [codex], profileClaude: {} });
    await store.getState().probeSessionClaude("se1");
    expect(store.getState().sessionClaude).toEqual({});
  });

  it("stays as it was, with nothing thrown, when the ask fails", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    const held = store.getState().sessionClaude;
    api.data.sessions = [];
    await expect(store.getState().probeSessionClaude("se1", true)).resolves.toBeUndefined();
    expect(store.getState().sessionClaude).toBe(held);
  });

  it("is one call however many panes ask for it at once", async () => {
    const { api, store } = await twoAccounts();
    api.delays["probeAgent"] = 10;
    await Promise.all([store.getState().probeSessionClaude("se1"), store.getState().probeSessionClaude("se1"), store.getState().probeSessionClaude("se1")]);
    expect(sessionAsks(api, "se1")).toEqual(["probeAgent:claude:plain:session:se1"]);
  });

  it("is asked for afresh even while an unforced ask for it is in flight", async () => {
    const { api, store } = await twoAccounts();
    api.delays["probeAgent"] = 10;
    await Promise.all([store.getState().probeSessionClaude("se1"), store.getState().probeSessionClaude("se1", true)]);
    expect(sessionAsks(api, "se1")).toEqual(["probeAgent:claude:plain:session:se1", "probeAgent:claude:forced:session:se1"]);
  });

  it("is asked for again once the ask before it has landed", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    await store.getState().probeSessionClaude("se1");
    expect(sessionAsks(api, "se1")).toHaveLength(2);
  });

  it("is asked for again after an ask for it has failed", async () => {
    const { api, store } = await twoAccounts();
    const held = api.data.sessions;
    api.data.sessions = [];
    await store.getState().probeSessionClaude("se1");
    api.data.sessions = held;
    await store.getState().probeSessionClaude("se1");
    expect(store.getState().sessionClaude.se1?.account?.email).toBe("work@example.com");
  });

  it("is kept apart from another session's, which is asked for on its own", async () => {
    const { api, store } = await twoAccounts();
    api.delays["probeAgent"] = 10;
    await Promise.all([store.getState().probeSessionClaude("se1"), store.getState().probeSessionClaude("se2")]);
    expect(api.calls.filter((c) => c.includes(":session:"))).toEqual(["probeAgent:claude:plain:session:se1", "probeAgent:claude:plain:session:se2"]);
    expect(Object.fromEntries(Object.entries(store.getState().sessionClaude).map(([id, r]) => [id, r.account?.email]))).toEqual({ se1: "work@example.com", se2: "me@example.com" });
  });

  it("is asked for afresh when its session fails to authenticate", async () => {
    const { api, store } = await twoAccounts();
    store.getState().applySessionEvent(live("se1", sessionEvent("error", { message: "401", failure: "auth" })));
    expect(sessionAsks(api, "se1")).toEqual(["probeAgent:claude:forced:session:se1"]);
  });

  it("is asked for afresh for every session that has one when a Claude session fails to authenticate, since they may run under its folder", async () => {
    const { api, store } = await twoAccounts({ sessions: [session("se1", "s1", { agentKind: "claude" }), session("se3", "s1", { agentKind: "claude" })] });
    await store.getState().probeSessionClaude("se1");
    await store.getState().probeSessionClaude("se3");
    api.calls.length = 0;
    store.getState().applySessionEvent(live("se1", sessionEvent("error", { message: "401", failure: "auth" })));
    expect(api.calls.filter((c) => c.includes(":session:"))).toEqual(["probeAgent:claude:forced:session:se1", "probeAgent:claude:forced:session:se3"]);
  });

  it("is asked for afresh for the session that failed too, where the window holds a row for another session and none for it", async () => {
    const { api, store } = await twoAccounts({ sessions: [session("se1", "s1", { agentKind: "claude" }), session("se3", "s1", { agentKind: "claude" })] });
    await store.getState().probeSessionClaude("se3");
    api.calls.length = 0;
    store.getState().applySessionEvent(live("se1", sessionEvent("error", { message: "401", failure: "auth" })));
    expect(api.calls.filter((c) => c.includes(":session:"))).toEqual(["probeAgent:claude:forced:session:se3", "probeAgent:claude:forced:session:se1"]);
  });

  it("is left as it was for every session when it is another agent's session that failed to authenticate", async () => {
    const { api, store } = await twoAccounts({ sessions: [session("se1", "s1", { agentKind: "codex" }), session("se3", "s1", { agentKind: "claude" })] });
    await store.getState().probeSessionClaude("se3");
    api.calls.length = 0;
    store.getState().applySessionEvent(live("se1", sessionEvent("error", { message: "401", failure: "auth" })));
    expect(api.calls.filter((c) => c.includes(":session:"))).toEqual([]);
  });

  it("does not stand in for every agent's probe, which a Claude session that fails to authenticate still asks afresh", async () => {
    const { api, store } = await twoAccounts();
    store.getState().applySessionEvent(live("se1", sessionEvent("error", { message: "401", failure: "auth" })));
    expect(api.calls).toContain("probeAgents:forced:p1");
  });

  it("is not asked for when the session that failed is another profile's, which this window does not hold", async () => {
    const { api, store } = await twoAccounts();
    store.getState().applySessionEvent(live("se2", sessionEvent("error", { message: "401", failure: "auth" })));
    expect(sessionAsks(api, "se2")).toEqual([]);
  });

  it("is asked for afresh for every session that has one when a Claude session of another profile fails to authenticate, since two profiles can run under one folder", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    expect(store.getState().sessions.se2).toBeUndefined();
    api.calls.length = 0;
    store.getState().applySessionEvent(live("se2", sessionEvent("error", { message: "401", failure: "auth" })));
    expect(api.calls.filter((c) => c.includes(":session:"))).toEqual(["probeAgent:claude:forced:session:se1"]);
  });

  it("is left as it was for every session when the session of another profile that failed to authenticate runs another agent", async () => {
    const { api, store } = await twoAccounts({ sessions: [session("se1", "s1", { agentKind: "claude" }), session("se2", "s2", { agentKind: "codex" })] });
    await store.getState().probeSessionClaude("se1");
    api.calls.length = 0;
    store.getState().applySessionEvent(live("se2", sessionEvent("error", { message: "401", failure: "auth" })));
    expect(api.calls.filter((c) => c.includes(":session:"))).toEqual([]);
  });

  it("is not asked for when the session that failed to authenticate runs another agent", async () => {
    const { api, store } = await twoAccounts({ sessions: [session("se1", "s1", { agentKind: "codex" })] });
    store.getState().applySessionEvent(live("se1", sessionEvent("error", { message: "401", failure: "auth" })));
    expect(sessionAsks(api, "se1")).toEqual([]);
  });

  it("is not asked for when a session fails for a reason that is not its sign-in", async () => {
    const { api, store } = await twoAccounts();
    store.getState().applySessionEvent(live("se1", sessionEvent("error", { message: "TypeError: x is not a function" })));
    expect(sessionAsks(api, "se1")).toEqual([]);
  });

  it("is asked for again, unforced, when a session that has one starts", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    store.getState().applySessionEvent(live("se1", sessionEvent("init", { providerSessionId: "conversation-1", model: "claude-opus-5-5", tools: [], cwd: "/tmp" })));
    expect(sessionAsks(api, "se1")).toEqual(["probeAgent:claude:plain:session:se1", "probeAgent:claude:plain:session:se1"]);
  });

  it("is not asked for when a session nobody has asked about starts", async () => {
    const { api, store } = await twoAccounts();
    store.getState().applySessionEvent(live("se1", sessionEvent("init", { providerSessionId: "conversation-1", model: "claude-opus-5-5", tools: [], cwd: "/tmp" })));
    expect(sessionAsks(api, "se1")).toEqual([]);
  });

  it("is asked for afresh, for every session that has one, once a Claude sign-in is done", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    await store.getState().probeSessionClaude("se2");
    api.calls.length = 0;
    store.getState().applyAgentSignIn(signIn({ id: "a", kind: "claude", state: "done" }));
    expect(api.calls.filter((c) => c.includes(":session:"))).toEqual(["probeAgent:claude:forced:session:se1", "probeAgent:claude:forced:session:se2"]);
  });

  it("is asked for no session that nobody has asked about, once a Claude sign-in is done", async () => {
    const { api, store } = await twoAccounts();
    store.getState().applyAgentSignIn(signIn({ id: "a", kind: "claude", state: "done" }));
    expect(api.calls.filter((c) => c.includes(":session:"))).toEqual([]);
  });

  it("is left alone while a Claude sign-in is still under way", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    store.getState().applyAgentSignIn(signIn({ id: "a", kind: "claude", state: "browser" }));
    expect(sessionAsks(api, "se1")).toHaveLength(1);
  });

  it("is left alone when it is another agent that signed in", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    store.getState().applyAgentSignIn(signIn({ id: "a", kind: "codex", state: "done" }));
    expect(sessionAsks(api, "se1")).toHaveLength(1);
  });

  it("is asked for afresh once an install of Claude Code finishes, whichever window ran it", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    store.getState().applyCliDone({ id: "another-window's-job", kind: "claude", ok: true, code: 0, error: null });
    expect(sessionAsks(api, "se1")).toEqual(["probeAgent:claude:plain:session:se1", "probeAgent:claude:forced:session:se1"]);
  });

  it("is asked for no session that nobody has asked about, once an install of Claude Code finishes", async () => {
    const { api, store } = await twoAccounts();
    store.getState().applyCliDone({ id: "job-claude", kind: "claude", ok: true, code: 0, error: null });
    expect(api.calls.filter((c) => c.includes(":session:"))).toEqual([]);
  });

  it("is asked for afresh when the install of Claude Code failed, which can still have changed the CLI", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    store.getState().applyCliDone({ id: "job-claude", kind: "claude", ok: false, code: 1, error: "npm exited with 1" });
    expect(sessionAsks(api, "se1")).toEqual(["probeAgent:claude:plain:session:se1", "probeAgent:claude:forced:session:se1"]);
  });

  it("is left alone when it is another agent's install that finished", async () => {
    const { api, store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    store.getState().applyCliDone({ id: "job-codex", kind: "codex", ok: true, code: 0, error: null });
    expect(sessionAsks(api, "se1")).toHaveLength(1);
  });

  it("goes with its session when the session is deleted", async () => {
    const { store } = await twoAccounts();
    await store.getState().probeSessionClaude("se1");
    await store.getState().deleteItem("i1");
    expect(store.getState().sessionClaude).toEqual({});
  });

  it("does not come back when an answer for a deleted session lands late", async () => {
    const { api, store } = await twoAccounts();
    api.delays["probeAgent"] = 20;
    const asked = store.getState().probeSessionClaude("se1");
    await store.getState().deleteItem("i1");
    await asked;
    expect(store.getState().sessionClaude).toEqual({});
  });

  it("does not come back when the answer that lands late for a deleted session was asked afresh", async () => {
    const { api, store } = await twoAccounts();
    api.delays["probeAgent"] = 20;
    const asked = store.getState().probeSessionClaude("se1", true);
    await store.getState().deleteItem("i1");
    await asked;
    expect(store.getState().sessionClaude).toEqual({});
  });

  it("is still held for another session whose answer was on its way when a session was deleted", async () => {
    const { api, store } = await twoAccounts();
    api.delays["probeAgent"] = 20;
    const asked = store.getState().probeSessionClaude("se2");
    await store.getState().deleteItem("i1");
    await asked;
    expect(store.getState().sessionClaude.se2?.account?.email).toBe("me@example.com");
  });

  it("goes with the quick chat when the chat is closed", async () => {
    const { store } = await twoAccounts();
    await store.getState().openQuickChat();
    const chat = store.getState().quickChat!.sessionId;
    await store.getState().probeSessionClaude(chat);
    expect(Object.keys(store.getState().sessionClaude)).toEqual([chat]);
    await store.getState().closeQuickChat();
    expect(store.getState().sessionClaude).toEqual({});
  });
});
