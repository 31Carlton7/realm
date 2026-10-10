import { describe, expect, it, vi } from "vitest";
import type { AgentKind, ClaudeDir } from "@realm/contracts";
import type { StoreApi } from "zustand";
import { createAppStore, type AgentProbe, type AppState } from "./store";
import { claudeFolder, claudeRow, fakeApi, item, profile, session, space, type FakeApi, type FakeData } from "./store.test-fakes";

/** Every `rpc().call` the live Api makes, so the params it puts on the wire can be read back. */
const wire: { method: string; params: unknown }[] = [];
/** What the server answers a method with, for the calls whose answer the live Api reads. Every
 *  other call is answered with nothing in it. */
const answers: Record<string, unknown> = {};
vi.mock("../rpc/client", () => ({
  rpc: () => ({ call: (method: string, params: unknown) => { wire.push({ method, params }); return Promise.resolve(answers[method] ?? {}); } }),
}));
vi.mock("../panes/terminal-hub", () => ({ getTerminalHub: () => ({ dispose: () => {} }) }));

const { liveApi } = await import("./live-api");

/** What the live Api sent for the calls made since the log was last emptied. */
const sent = (): { method: string; params: unknown }[] => wire.splice(0, wire.length);

/** App.tsx as text with its comments taken out, so prose about an event cannot read as a
 *  subscription to it. The window's subscriptions are made inside one effect that no render in this
 *  suite reaches, which leaves the source as the only place to ask whether one is there. */
const APP = Object.values(import.meta.glob("../App.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0]!
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** An agent whose row no Claude config folder decides. */
const codex: AgentProbe = { kind: "codex", available: true, version: "1.0", loggedIn: true, reason: null };

const WORK = "/Users/u/.claude-work";
const PERSONAL = "/Users/u/.claude-personal";
const MOVED = "/Users/u/.claude-moved";

/**
 * A home where Work (p1) names one Claude config folder and Personal (p2) another, each signed in
 * as its own account. Each profile has a space, and each space a Claude session that holds no
 * conversation yet: `se1` in Work's, `se2` in Personal's.
 */
const accounts = (over: FakeData = {}): FakeApi => fakeApi({
  profiles: [profile("p1", "Work"), profile("p2", "Personal")],
  spaces: [space("s1", "p1", "Versed"), space("s2", "p2", "Thesis")],
  items: { s1: [item("i1", "s1", { kind: "session", refId: "se1" })], s2: [item("i2", "s2", { kind: "session", refId: "se2" })] },
  sessions: [session("se1", "s1", { agentKind: "claude" }), session("se2", "s2", { agentKind: "claude" })],
  agentProbe: [claudeRow("default@example.com"), codex],
  profileClaude: { p1: claudeRow("work@example.com", WORK), p2: claudeRow("me@example.com", PERSONAL) },
  claudeDirs: { p1: claudeFolder(WORK), p2: claudeFolder(PERSONAL) },
  ...over,
});

/** That home in a booted window, which opens on Work. */
async function onWork(over: FakeData = {}) {
  const api = accounts(over);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

/** Claude's row in `agentProbe`. */
const claudeOf = (store: StoreApi<AppState>): AgentProbe | undefined => store.getState().agentProbe.find((r) => r.kind === "claude");
/** The account on that row, or null where the row names none. */
const emailOf = (store: StoreApi<AppState>): string | null => claudeOf(store)?.account?.email ?? null;

/** The whole probes the fake logged with a profile named, in the order they were asked. */
const probesAsked = (api: FakeApi): string[] => api.calls.filter((c) => c.startsWith("probeAgents:plain:") || c.startsWith("probeAgents:forced:"));
/** The asks the fake logged for sessions' own Claude rows, in the order they were made. */
const sessionAsks = (api: FakeApi): string[] => api.calls.filter((c) => c.includes(":session:"));

/**
 * Takes the fake's whole probe over, so a test lands each answer itself, in the order a race would.
 * Answers one entry per call, in the order the calls were made.
 */
function heldProbes(api: FakeApi) {
  const asked: { force: boolean; profileId: string | null; land: (rows: AgentProbe[]) => void }[] = [];
  api.probeAgents = (force, profileId) => new Promise((resolve) => { asked.push({ force, profileId: profileId ?? null, land: resolve }); });
  return asked;
}

/** The same for one agent's row, which is also how a session's own Claude row is asked for. */
function heldRows(api: FakeApi) {
  const asked: { kind: AgentKind; sessionId: string | null; force: boolean; land: (row: AgentProbe | null) => void }[] = [];
  api.probeAgent = (kind, o) => new Promise((resolve) => { asked.push({ kind, sessionId: o?.sessionId ?? null, force: o?.force !== false, land: resolve }); });
  return asked;
}

/** Holds one profile's folder read back, as a reply slow on the wire, until a test lands it. Every
 *  other profile's read answers as the fake does. */
function heldFolder(api: FakeApi, profileId: string) {
  const held: { land: (answer: ClaudeDir) => void } = { land: () => {} };
  const answering = api.claudeDir;
  api.claudeDir = (id) => (id === profileId ? new Promise((resolve) => { held.land = resolve; }) : answering(id));
  return held;
}

/** `agentProbe` as it stood in the very write that changed the window's profile, which is what a
 *  pane drawn for the profile entered sees first. Null until the profile has changed. */
function atTheSwitch(store: StoreApi<AppState>): { rows: AgentProbe[] | null } {
  const seen: { rows: AgentProbe[] | null } = { rows: null };
  store.subscribe((s, prev) => { if (s.activeProfileId !== prev.activeProfileId) seen.rows = s.agentProbe; });
  return seen;
}

/** `agentProbe` as it stood in the very write that held a profile's folder, which is the first a
 *  pane sees of the change. Null until a folder has been held. */
function atTheHold(store: StoreApi<AppState>): { rows: AgentProbe[] | null } {
  const seen: { rows: AgentProbe[] | null } = { rows: null };
  store.subscribe((s, prev) => { if (s.claudeDirs !== prev.claudeDirs) seen.rows = s.agentProbe; });
  return seen;
}

describe("each profile's Claude config folder in the store", () => {
  it("is read for every profile as the window opens", async () => {
    const { api, store } = await onWork();
    expect(api.calls.filter((c) => c.startsWith("claudeDir:"))).toEqual(["claudeDir:p1", "claudeDir:p2"]);
    expect(store.getState().claudeDirs).toEqual({ p1: claudeFolder(WORK), p2: claudeFolder(PERSONAL) });
  });

  it("is read again whenever the profiles are", async () => {
    const { api, store } = await onWork();
    api.data.profiles = [...api.data.profiles, profile("p3", "Client")];
    api.data.claudeDirs.p3 = claudeFolder("/Users/u/.claude-client");
    await store.getState().refreshProfiles();
    expect(store.getState().claudeDirs.p3).toEqual(claudeFolder("/Users/u/.claude-client"));
  });

  it("keeps what it could read, and what it held, when one profile's read fails", async () => {
    const { api, store } = await onWork();
    api.data.profiles = api.data.profiles.filter((p) => p.id !== "p2");
    api.data.claudeDirs.p1 = claudeFolder(MOVED);
    await store.getState().loadClaudeDirs();
    expect(store.getState().claudeDirs).toEqual({ p1: claudeFolder(MOVED), p2: claudeFolder(PERSONAL) });
  });

  it("makes no write to the store when no profile's read answers", async () => {
    const { api, store } = await onWork();
    const held = store.getState().claudeDirs;
    api.data.profiles = [];
    await store.getState().loadClaudeDirs();
    expect(store.getState().claudeDirs).toBe(held);
  });

  it("does not keep the window from opening while a folder is slow to answer", async () => {
    const api = accounts();
    api.claudeDir = () => new Promise(() => {});
    const store = createAppStore(api);
    await store.getState().boot();
    expect(store.getState().booted).toBe(true);
  });

  it("takes no sign-in off when the folder of the window's profile is first read after its probe has landed", async () => {
    const api = accounts();
    const read = heldFolder(api, "p1");
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().probeAgents();
    const rows = store.getState().agentProbe;
    read.land(claudeFolder(WORK));
    await vi.waitFor(() => expect(store.getState().claudeDirs.p1).toEqual(claudeFolder(WORK)));
    expect(store.getState().agentProbe).toBe(rows);
  });

  it("still holds Claude's own row that was on its way when the folders were first read", async () => {
    const api = accounts();
    const read = heldFolder(api, "p1");
    const store = createAppStore(api);
    await store.getState().boot();
    const asked = heldRows(api);
    const before = store.getState().probeAgent("claude");
    read.land(claudeFolder(WORK));
    await vi.waitFor(() => expect(store.getState().claudeDirs.p1).toEqual(claudeFolder(WORK)));
    asked[0]!.land(claudeRow("work@example.com", WORK));
    await before;
    expect(emailOf(store)).toBe("work@example.com");
  });

  it("is not put back by a read that was asked before the folder was named", async () => {
    const { api, store } = await onWork();
    api.delays["claudeDir:p1"] = 20;
    const reading = store.getState().loadClaudeDirs();
    await store.getState().setClaudeDir("p1", MOVED);
    await reading;
    expect(store.getState().claudeDirs.p1).toEqual(claudeFolder(MOVED));
  });

  it("is named through the server, whose answer is held and handed back", async () => {
    const { api, store } = await onWork();
    const answer = await store.getState().setClaudeDir("p2", MOVED);
    expect(api.calls).toContain(`setClaudeDir:p2=${MOVED}`);
    expect(answer).toEqual(claudeFolder(MOVED));
    expect(store.getState().claudeDirs.p2).toBe(answer);
  });

  it("goes back to the default folder when it is set to null", async () => {
    const { api, store } = await onWork();
    await store.getState().setClaudeDir("p1", null);
    expect(api.calls).toContain("setClaudeDir:p1=default");
    expect(store.getState().claudeDirs.p1).toEqual(claudeFolder(null));
  });

  it("rejects with the server's sentence when the folder is refused, and holds what it held", async () => {
    const { store } = await onWork();
    await expect(store.getState().setClaudeDir("p1", "claude-work")).rejects.toThrow("A Claude config folder needs a full path, such as ~/.claude-work.");
    expect(store.getState().claudeDirs.p1).toEqual(claudeFolder(WORK));
  });

  it("is read again once the window is back in touch with the server, which may have missed a change", async () => {
    const { api, store } = await onWork();
    api.data.claudeDirs.p2 = claudeFolder(MOVED);
    store.getState().applyConnectionState("reconnecting");
    store.getState().applyConnectionState("connected");
    await vi.waitFor(() => expect(store.getState().claudeDirs.p2).toEqual(claudeFolder(MOVED)));
  });

  it("takes a read that finds the window's profile on another folder as the event it missed", async () => {
    const { api, store } = await onWork();
    await store.getState().probeAgents();
    expect(emailOf(store)).toBe("work@example.com");
    api.data.claudeDirs.p1 = claudeFolder(MOVED);
    api.data.profileClaude.p1 = claudeRow("moved@example.com", MOVED);
    const seen = atTheHold(store);
    const asked = probesAsked(api).length;
    await store.getState().loadClaudeDirs();
    expect(store.getState().claudeDirs.p1).toEqual(claudeFolder(MOVED));
    expect(seen.rows?.find((r) => r.kind === "claude")).toMatchObject({ loggedIn: null });
    expect(probesAsked(api).slice(asked)).toEqual(["probeAgents:plain:p1"]);
    await vi.waitFor(() => expect(emailOf(store)).toBe("moved@example.com"));
  });

  it("asks for nothing when a read finds every profile's folder where it was", async () => {
    const { api, store } = await onWork();
    await store.getState().probeAgents();
    const calls = api.calls.length;
    await store.getState().loadClaudeDirs();
    expect(api.calls.slice(calls).filter((c) => !c.startsWith("claudeDir:"))).toEqual([]);
    expect(emailOf(store)).toBe("work@example.com");
  });

  it("is shown beside the home folder the server states, which is null where it states none", async () => {
    const { store } = await onWork();
    expect(store.getState().userHome).toBe("/Users/carlton");
    const api = accounts();
    api.systemInfo = async () => ({ machineName: "", userName: "", detachedSince: null });
    const silent = createAppStore(api);
    expect(silent.getState().userHome).toBeNull();
    await silent.getState().boot();
    expect(silent.getState().userHome).toBeNull();
  });

  it("takes Claude's sign-in off the row when the active profile is named another folder, before any event says so", async () => {
    const { store } = await onWork();
    await store.getState().probeAgents();
    await store.getState().setClaudeDir("p1", MOVED);
    expect(claudeOf(store)).toEqual({ kind: "claude", available: true, version: "2.1.296", loggedIn: null, reason: null });
  });

  it("leaves Claude's row alone when it is another profile that is named a folder", async () => {
    const { store } = await onWork();
    await store.getState().probeAgents();
    const rows = store.getState().agentProbe;
    await store.getState().setClaudeDir("p2", MOVED);
    expect(store.getState().agentProbe).toBe(rows);
  });
});

describe("a profile's folder changing, in this window or another", () => {
  it("is held as the event states it, without the profile's id in the answer", async () => {
    const { store } = await onWork();
    store.getState().applyClaudeDir({ profileId: "p2", ...claudeFolder(MOVED, { missing: true }) });
    expect(store.getState().claudeDirs.p2).toStrictEqual(claudeFolder(MOVED, { missing: true }));
  });

  it("asks for the probe again where the profile is the one the window shows", async () => {
    const { api, store } = await onWork();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(probesAsked(api)).toEqual(["probeAgents:plain:p1"]);
  });

  it("asks for the probe again where the event names the folder the window's profile was already on", async () => {
    const { api, store } = await onWork();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(WORK) });
    expect(probesAsked(api)).toEqual(["probeAgents:plain:p1"]);
  });

  it("asks for no probe where it is another profile's folder", async () => {
    const { api, store } = await onWork();
    store.getState().applyClaudeDir({ profileId: "p2", ...claudeFolder(MOVED) });
    expect(probesAsked(api)).toEqual([]);
  });

  it("asks for no probe before any profile is the window's", async () => {
    const api = accounts();
    const store = createAppStore(api);
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(api.calls.filter((c) => c.startsWith("probeAgents"))).toEqual([]);
  });

  it("takes Claude's sign-in off the row at once when the active profile is on another folder now", async () => {
    const { store } = await onWork();
    await store.getState().probeAgents();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(claudeOf(store)).toEqual({ kind: "claude", available: true, version: "2.1.296", loggedIn: null, reason: null });
  });

  it("takes the sign-in off in the same write that holds the folder the window's profile moved to", async () => {
    const { store } = await onWork();
    await store.getState().probeAgents();
    const seen = atTheHold(store);
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(seen.rows?.[0]).toEqual({ kind: "claude", available: true, version: "2.1.296", loggedIn: null, reason: null });
  });

  it("still counts every agent as probed when Claude's sign-in is taken off", async () => {
    const { store } = await onWork();
    await store.getState().probeAgents();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(store.getState().agentsProbed).toBe(true);
  });

  it("takes it off when the active profile's folder was not known before the event", async () => {
    const { store } = await onWork();
    await store.getState().probeAgents();
    store.setState({ claudeDirs: {} });
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(WORK) });
    expect(emailOf(store)).toBeNull();
  });

  it("keeps Claude's row when the event names the folder the active profile was already on", async () => {
    const { store } = await onWork();
    await store.getState().probeAgents();
    const rows = store.getState().agentProbe;
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(WORK, { missing: true }) });
    expect(store.getState().agentProbe).toBe(rows);
  });

  it("leaves Claude's row alone when it is another profile's folder that changed", async () => {
    const { store } = await onWork();
    await store.getState().probeAgents();
    const rows = store.getState().agentProbe;
    store.getState().applyClaudeDir({ profileId: "p2", ...claudeFolder(MOVED) });
    expect(store.getState().agentProbe).toBe(rows);
  });

  it("shows the account of the new folder once the probe it asked for lands", async () => {
    const { api, store } = await onWork();
    await store.getState().probeAgents();
    api.data.profileClaude.p1 = claudeRow("moved@example.com", MOVED);
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    await vi.waitFor(() => expect(emailOf(store)).toBe("moved@example.com"));
  });

  it("does not join a probe that was asked before the folder changed", async () => {
    const { api, store } = await onWork();
    const asked = heldProbes(api);
    void store.getState().probeAgents();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(asked.map((a) => a.profileId)).toEqual(["p1", "p1"]);
  });

  it("does not join a probe asked before this window named the folder, when the event comes after the naming", async () => {
    const { api, store } = await onWork();
    const asked = heldProbes(api);
    void store.getState().probeAgents();
    await store.getState().setClaudeDir("p1", MOVED);
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(asked.map((a) => a.profileId)).toEqual(["p1", "p1"]);
  });

  it("drops the answer asked before the folder changed when it lands after the one asked since", async () => {
    const { api, store } = await onWork();
    const asked = heldProbes(api);
    const before = store.getState().probeAgents();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    asked[1]!.land([claudeRow("moved@example.com", MOVED), codex]);
    await vi.waitFor(() => expect(emailOf(store)).toBe("moved@example.com"));
    asked[0]!.land([claudeRow("work@example.com", WORK), codex]);
    await before;
    expect(emailOf(store)).toBe("moved@example.com");
  });

  it("holds the answer asked since the folder changed when the one asked before lands first", async () => {
    const { api, store } = await onWork();
    const asked = heldProbes(api);
    const before = store.getState().probeAgents();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    asked[0]!.land([claudeRow("work@example.com", WORK), codex]);
    await before;
    asked[1]!.land([claudeRow("moved@example.com", MOVED), codex]);
    await vi.waitFor(() => expect(emailOf(store)).toBe("moved@example.com"));
  });

  it("shows no account when the answer asked before the folder changed lands first", async () => {
    const { api, store } = await onWork();
    const asked = heldProbes(api);
    const before = store.getState().probeAgents();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    asked[0]!.land([claudeRow("work@example.com", WORK), codex]);
    await before;
    expect(emailOf(store)).toBeNull();
  });

  it.each([["an unforced", false], ["a forced", true]] as const)("still holds the answer to %s probe of the window's own profile when another profile's folder changes", async (_asked, force) => {
    const { api, store } = await onWork();
    const asked = heldProbes(api);
    const before = store.getState().probeAgents(force);
    store.getState().applyClaudeDir({ profileId: "p2", ...claudeFolder(MOVED) });
    asked[0]!.land([claudeRow("work@example.com", WORK), codex]);
    await before;
    expect(emailOf(store)).toBe("work@example.com");
  });

  it("takes no account from Claude's own row that was asked before the folder changed", async () => {
    const { api, store } = await onWork();
    await store.getState().probeAgents();
    const asked = heldRows(api);
    heldProbes(api);
    const before = store.getState().probeAgent("claude");
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    asked[0]!.land(claudeRow("work@example.com", WORK));
    await before;
    expect(emailOf(store)).toBeNull();
  });

  it("still holds Claude's own row that was on its way when it was another profile's folder that changed", async () => {
    const { api, store } = await onWork();
    const asked = heldRows(api);
    const before = store.getState().probeAgent("claude");
    store.getState().applyClaudeDir({ profileId: "p2", ...claudeFolder(MOVED) });
    asked[0]!.land(claudeRow("work@example.com", WORK));
    await before;
    expect(emailOf(store)).toBe("work@example.com");
  });

  it("still holds another agent's row that was on its way when the folder changed", async () => {
    const { api, store } = await onWork();
    await store.getState().probeAgents();
    const asked = heldRows(api);
    heldProbes(api);
    const before = store.getState().probeAgent("codex");
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    asked[0]!.land({ ...codex, version: "2.0" });
    await before;
    expect(store.getState().agentProbe.find((r) => r.kind === "codex")?.version).toBe("2.0");
  });

  it("asks afresh where a forced probe was in flight when the folder changed", async () => {
    const { api, store } = await onWork();
    const asked = heldProbes(api);
    void store.getState().probeAgents(true);
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(asked.map((a) => a.force)).toEqual([true, true]);
  });

  it("lets go of another profile's probe in flight too, so going back there asks again", async () => {
    const { api, store } = await onWork();
    const asked = heldProbes(api);
    void store.getState().probeAgents();
    store.setState({ activeProfileId: "p2" });
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    store.setState({ activeProfileId: "p1" });
    void store.getState().probeAgents();
    expect(asked.map((a) => a.profileId)).toEqual(["p1", "p1"]);
  });

  it("asks for no session's own row where none is held or on its way", async () => {
    const { api, store } = await onWork();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(sessionAsks(api)).toEqual([]);
  });

  it("asks again, unforced, for the own row of every session that has one, whichever profile it was", async () => {
    const { api, store } = await onWork();
    await store.getState().probeSessionClaude("se1");
    await store.getState().probeSessionClaude("se2");
    api.calls.length = 0;
    store.getState().applyClaudeDir({ profileId: "p2", ...claudeFolder(MOVED) });
    expect(sessionAsks(api)).toEqual(["probeAgent:claude:plain:session:se1", "probeAgent:claude:plain:session:se2"]);
  });

  it("asks again for a session whose first answer has not landed yet", async () => {
    const { api, store } = await onWork();
    const asked = heldRows(api);
    void store.getState().probeSessionClaude("se1");
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(asked.map((a) => a.sessionId)).toEqual(["se1", "se1"]);
  });

  it("asks once for a session that has a row and an ask in flight", async () => {
    const { api, store } = await onWork();
    await store.getState().probeSessionClaude("se1");
    const asked = heldRows(api);
    void store.getState().probeSessionClaude("se1");
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(asked.map((a) => a.sessionId)).toEqual(["se1", "se1"]);
  });

  it("holds no row for a session when the answer asked before the folder changed lands first", async () => {
    const { api, store } = await onWork();
    const asked = heldRows(api);
    const before = store.getState().probeSessionClaude("se1");
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    asked[0]!.land(claudeRow("work@example.com", WORK));
    await before;
    expect(store.getState().sessionClaude).toEqual({});
  });

  it("drops a session's answer asked before the folder changed when it lands after the one asked since", async () => {
    const { api, store } = await onWork();
    const asked = heldRows(api);
    const before = store.getState().probeSessionClaude("se1");
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    asked[1]!.land(claudeRow("moved@example.com", MOVED));
    await vi.waitFor(() => expect(store.getState().sessionClaude.se1?.account?.email).toBe("moved@example.com"));
    asked[0]!.land(claudeRow("work@example.com", WORK));
    await before;
    expect(store.getState().sessionClaude.se1?.account?.email).toBe("moved@example.com");
  });

  it("holds a session's answer asked since the folder changed when the one asked before lands first", async () => {
    const { api, store } = await onWork();
    const asked = heldRows(api);
    const before = store.getState().probeSessionClaude("se1");
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    asked[0]!.land(claudeRow("work@example.com", WORK));
    await before;
    asked[1]!.land(claudeRow("moved@example.com", MOVED));
    await vi.waitFor(() => expect(store.getState().sessionClaude.se1?.account?.email).toBe("moved@example.com"));
  });

  it("asks afresh for a session whose forced ask was in flight when the folder changed", async () => {
    const { api, store } = await onWork();
    const asked = heldRows(api);
    void store.getState().probeSessionClaude("se1", true);
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(asked.map((a) => a.force)).toEqual([true, true]);
  });

  it("asks afresh only for the session whose forced ask was in flight, and unforced for the rest", async () => {
    const { api, store } = await onWork();
    await store.getState().probeSessionClaude("se2");
    const asked = heldRows(api);
    void store.getState().probeSessionClaude("se1", true);
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(asked.slice(1).map((a) => [a.sessionId, a.force])).toEqual([["se2", false], ["se1", true]]);
  });
});

describe("whether any folder is in use, as every held answer says it", () => {
  it("is no on every held answer once this window gives the last folder back", async () => {
    const { store } = await onWork({ profileClaude: {}, claudeDirs: { p1: claudeFolder(WORK), p2: claudeFolder(null, { anyNamed: true }) } });
    await store.getState().setClaudeDir("p1", null);
    expect(store.getState().claudeDirs).toEqual({ p1: claudeFolder(null), p2: claudeFolder(null) });
  });

  it("is yes on every held answer once another window names a folder", async () => {
    const { store } = await onWork({ profileClaude: {}, claudeDirs: {} });
    expect(store.getState().claudeDirs).toEqual({ p1: claudeFolder(null), p2: claudeFolder(null) });
    store.getState().applyClaudeDir({ profileId: "p2", ...claudeFolder(MOVED) });
    expect(store.getState().claudeDirs).toEqual({ p1: claudeFolder(null, { anyNamed: true }), p2: claudeFolder(MOVED) });
  });

  it("is left on an answer that already said so without making the answer anew, so nothing that reads it draws again", async () => {
    const { store } = await onWork();
    const held = store.getState().claudeDirs.p2;
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    expect(store.getState().claudeDirs.p2).toBe(held);
  });

  it("is not taken from a read that lands late, for a profile that has named a folder since the read was asked", async () => {
    const { api, store } = await onWork({ profileClaude: {}, claudeDirs: {} });
    const read = heldFolder(api, "p2");
    const reading = store.getState().loadClaudeDirs();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(WORK) });
    read.land(claudeFolder(null));
    await reading;
    expect(store.getState().claudeDirs).toEqual({ p1: claudeFolder(WORK), p2: claudeFolder(null) });
  });

  it("is taken from a late read for that read's own profile alone, where the read finds its profile on another folder", async () => {
    const { api, store } = await onWork();
    const read = heldFolder(api, "p2");
    const reading = store.getState().loadClaudeDirs();
    store.getState().applyClaudeDir({ profileId: "p1", ...claudeFolder(MOVED) });
    read.land(claudeFolder(null));
    await reading;
    expect(store.getState().claudeDirs).toEqual({ p1: claudeFolder(MOVED), p2: claudeFolder(null) });
  });
});

describe("the window moving to another profile", () => {
  it("keeps Claude's row when both profiles are known to be on one folder", async () => {
    const { store } = await onWork({ profileClaude: {}, claudeDirs: {} });
    await store.getState().probeAgents();
    const rows = store.getState().agentProbe;
    const seen = atTheSwitch(store);
    await store.getState().selectProfile("p2");
    expect(seen.rows).toBe(rows);
  });

  it("keeps Claude's row when both profiles name the same folder, which is not the default one", async () => {
    const { store } = await onWork({ profileClaude: { p1: claudeRow("work@example.com", WORK), p2: claudeRow("work@example.com", WORK) }, claudeDirs: { p1: claudeFolder(WORK), p2: claudeFolder(WORK) } });
    await store.getState().probeAgents();
    const rows = store.getState().agentProbe;
    const seen = atTheSwitch(store);
    await store.getState().selectProfile("p2");
    expect(seen.rows).toBe(rows);
  });

  it("asks for the new profile's probe when the row was kept", async () => {
    const { api, store } = await onWork({ profileClaude: {}, claudeDirs: {} });
    await store.getState().probeAgents();
    await store.getState().selectProfile("p2");
    expect(probesAsked(api)).toEqual(["probeAgents:plain:p1", "probeAgents:plain:p2"]);
  });

  it("takes Claude's sign-in off in the same write that changes the profile, where the folders differ", async () => {
    const { store } = await onWork();
    await store.getState().probeAgents();
    const seen = atTheSwitch(store);
    await store.getState().selectProfile("p2");
    expect(seen.rows).toEqual([{ kind: "claude", available: true, version: "2.1.296", loggedIn: null, reason: null }, codex]);
  });

  it("still counts every agent as probed once Claude's sign-in is taken off for the profile entered", async () => {
    const { api, store } = await onWork();
    await store.getState().probeAgents();
    heldProbes(api);
    await store.getState().selectProfile("p2");
    expect(store.getState().agentsProbed).toBe(true);
  });

  it("asks for the new profile's probe when the row was not kept, and shows its account when that lands", async () => {
    const { api, store } = await onWork();
    await store.getState().probeAgents();
    await store.getState().selectProfile("p2");
    expect(probesAsked(api)).toEqual(["probeAgents:plain:p1", "probeAgents:plain:p2"]);
    await vi.waitFor(() => expect(emailOf(store)).toBe("me@example.com"));
  });

  it("takes it off when the folder of the profile entered is not known yet", async () => {
    const { store } = await onWork({ profileClaude: {}, claudeDirs: {} });
    await store.getState().probeAgents();
    store.setState({ claudeDirs: { p1: claudeFolder(null) } });
    const seen = atTheSwitch(store);
    await store.getState().selectProfile("p2");
    expect(seen.rows?.[0]).toEqual({ kind: "claude", available: true, version: "2.1.296", loggedIn: null, reason: null });
  });

  it("takes it off when the folder of the profile left is not known yet", async () => {
    const { store } = await onWork({ profileClaude: {}, claudeDirs: {} });
    await store.getState().probeAgents();
    store.setState({ claudeDirs: { p2: claudeFolder(null) } });
    const seen = atTheSwitch(store);
    await store.getState().selectProfile("p2");
    expect(seen.rows?.[0]).toEqual({ kind: "claude", available: true, version: "2.1.296", loggedIn: null, reason: null });
  });

  it("takes it off when neither profile's folder is known yet", async () => {
    const { store } = await onWork({ profileClaude: {}, claudeDirs: {} });
    await store.getState().probeAgents();
    store.setState({ claudeDirs: {} });
    const seen = atTheSwitch(store);
    await store.getState().selectProfile("p2");
    expect(seen.rows?.[0]).toEqual({ kind: "claude", available: true, version: "2.1.296", loggedIn: null, reason: null });
  });

  it("asks for the new profile's probe even where none had been asked for the profile left", async () => {
    const { api, store } = await onWork();
    await store.getState().selectProfile("p2");
    expect(probesAsked(api)).toEqual(["probeAgents:plain:p2"]);
  });

  it("holds the answer for a profile the window left and came back to before it landed", async () => {
    const { api, store } = await onWork();
    const asked = heldProbes(api);
    void store.getState().probeAgents();
    await store.getState().selectProfile("p2");
    await store.getState().selectProfile("p1");
    asked[0]!.land([claudeRow("work@example.com", WORK), codex]);
    await vi.waitFor(() => expect(emailOf(store)).toBe("work@example.com"));
  });

  it("asks for no probe as the window first opens on a profile", async () => {
    const { api } = await onWork();
    expect(api.calls.filter((c) => c.startsWith("probeAgents"))).toEqual([]);
  });

  it("asks again as the window opens, where a probe was asked before any profile was its own", async () => {
    const api = accounts();
    const store = createAppStore(api);
    api.delays["probeAgents"] = 20;
    const early = store.getState().probeAgents();
    api.delays["probeAgents"] = 0;
    await store.getState().boot();
    await early;
    expect(probesAsked(api)).toEqual(["probeAgents:plain:p1"]);
    await vi.waitFor(() => expect(emailOf(store)).toBe("work@example.com"));
  });

  it("asks again as the window opens, where one agent's row was asked before any profile was its own", async () => {
    const api = accounts();
    const store = createAppStore(api);
    api.delays["probeAgent"] = 20;
    const early = store.getState().probeAgent("claude");
    await store.getState().boot();
    await early;
    expect(probesAsked(api)).toEqual(["probeAgents:plain:p1"]);
  });
});

describe("the wire for a profile's folder and the probes asked about it", () => {
  it("names the profile on agents.probe", async () => {
    sent();
    await liveApi().probeAgents(true, "01HQ0000000000000000000PR1");
    expect(sent()).toStrictEqual([{ method: "agents.probe", params: { force: true, profileId: "01HQ0000000000000000000PR1" } }]);
  });

  it("leaves the profile off agents.probe where there is none, null or not given", async () => {
    sent();
    await liveApi().probeAgents(false, null);
    await liveApi().probeAgents(false);
    expect(sent()).toStrictEqual([{ method: "agents.probe", params: { force: false } }, { method: "agents.probe", params: { force: false } }]);
  });

  it("asks agents.probeOne with the kind alone where nothing else is named", async () => {
    sent();
    await liveApi().probeAgent("codex");
    await liveApi().probeAgent("claude", { profileId: null });
    expect(sent()).toStrictEqual([{ method: "agents.probeOne", params: { kind: "codex" } }, { method: "agents.probeOne", params: { kind: "claude" } }]);
  });

  it("names the profile on agents.probeOne, and says nothing of force, which the server reads as afresh", async () => {
    sent();
    await liveApi().probeAgent("claude", { profileId: "01HQ0000000000000000000PR1", force: true });
    expect(sent()).toStrictEqual([{ method: "agents.probeOne", params: { kind: "claude", profileId: "01HQ0000000000000000000PR1" } }]);
  });

  it("names the session on agents.probeOne, and says force only to turn it off", async () => {
    sent();
    await liveApi().probeAgent("claude", { sessionId: "01HQ0000000000000000000SE1", force: false });
    expect(sent()).toStrictEqual([{ method: "agents.probeOne", params: { kind: "claude", sessionId: "01HQ0000000000000000000SE1", force: false } }]);
  });

  it("names the profile on agentSignIn.start, and leaves it off where there is none, null or not given", async () => {
    sent();
    await liveApi().agentSignInStart("claude", "01HQ0000000000000000000PR1");
    await liveApi().agentSignInStart("claude", null);
    await liveApi().agentSignInStart("codex");
    expect(sent()).toStrictEqual([
      { method: "agentSignIn.start", params: { kind: "claude", profileId: "01HQ0000000000000000000PR1" } },
      { method: "agentSignIn.start", params: { kind: "claude" } },
      { method: "agentSignIn.start", params: { kind: "codex" } },
    ]);
  });

  it("hands on the home folder system.info states, and null where it states none", async () => {
    answers["system.info"] = { machineName: "Mac", userName: "U", detachedSince: null, userHome: "/Users/u" };
    expect(await liveApi().systemInfo()).toStrictEqual({ machineName: "Mac", userName: "U", detachedSince: null, userHome: "/Users/u" });
    answers["system.info"] = { machineName: "Mac", userName: "U", detachedSince: null };
    expect(await liveApi().systemInfo()).toStrictEqual({ machineName: "Mac", userName: "U", detachedSince: null, userHome: null });
    delete answers["system.info"];
  });

  it("reads a profile's folder by the profile's id", async () => {
    sent();
    await liveApi().claudeDir("01HQ0000000000000000000PR1");
    expect(sent()).toStrictEqual([{ method: "agents.claudeDir", params: { profileId: "01HQ0000000000000000000PR1" } }]);
  });

  it("names a folder for a profile, and sends null itself to go back to the default one", async () => {
    sent();
    await liveApi().setClaudeDir("01HQ0000000000000000000PR1", MOVED);
    await liveApi().setClaudeDir("01HQ0000000000000000000PR1", null);
    expect(sent()).toStrictEqual([
      { method: "agents.setClaudeDir", params: { profileId: "01HQ0000000000000000000PR1", dir: MOVED } },
      { method: "agents.setClaudeDir", params: { profileId: "01HQ0000000000000000000PR1", dir: null } },
    ]);
  });
});

describe("the window, told that a profile's folder changed", () => {
  it("hands every agents.claudeDirChanged it hears to the store", () => {
    expect(APP).toMatch(/= rpc\(\)\.on\("agents\.claudeDirChanged", \(e\) => store\.getState\(\)\.applyClaudeDir\(e\)\);/);
  });

  it("stops listening for the event when it goes", () => {
    const heard = APP.match(/const (\w+) = rpc\(\)\.on\("agents\.claudeDirChanged",/);
    expect(APP).toMatch(new RegExp(`\\b${heard?.[1] ?? "nothing"}\\(\\);`));
  });
});
