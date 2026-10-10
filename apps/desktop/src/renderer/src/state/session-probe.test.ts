import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { ClaudeDir } from "@realm/contracts";
import type { StoreApi } from "zustand";
import { StoreContext, createAppStore, type AgentProbe, type AppState } from "./store";
import { agentAvailability } from "./agent-availability";
import { sessionProbeRows, unknownClaude, useSessionProbe, type ProbedSession } from "./session-probe";
import { claudeFolder, fakeApi, item, profile, session, space, type FakeApi } from "./store.test-fakes";

/** Claude as the active profile's folder has it: the work account, from a folder the profile names,
 *  with the models that account is offered. Frozen, as the two rows after it are, because every
 *  test here reads them: a function that changed the row it was handed would otherwise change what
 *  the tests after it compare against, and pass them. */
const work: AgentProbe = Object.freeze({
  kind: "claude", available: true, version: "2.1.296", loggedIn: true, reason: null,
  account: { email: "work@example.com", organization: "Acme", plan: "team" }, home: "/Users/u/.claude-work",
  models: [{ id: "claude-opus-5-5", label: "Opus 5.5" }],
});
/** The same CLI as another folder has it: another account. */
const personal: AgentProbe = Object.freeze({ ...work, account: { email: "me@example.com", organization: null, plan: "max" }, home: null });
/** An agent whose row no folder decides. */
const codex: AgentProbe = Object.freeze({ kind: "codex", available: true, version: "1.0", loggedIn: true, reason: null });
/** Claude as the server answers it for the active profile's folder once that folder is gone. */
const gone: AgentProbe = Object.freeze({
  kind: "claude", available: true, version: "2.1.296", loggedIn: false, reason: "The Claude config folder ~/.claude-work is missing.",
  home: "/Users/u/.claude-work", homeMissing: true,
});

/** Claude's row out of a list. */
const claudeOf = (rows: AgentProbe[]): AgentProbe | undefined => rows.find((r) => r.kind === "claude");

/** What the server says of an install where no profile names a folder and no conversation is noted
 *  under one, in both profiles' answers. */
const noneNamed = { p1: { anyNamed: false }, p2: { anyNamed: false } };

/** The rules asked with the window on profile p1, which holds space s1 and names a folder; s9 is a
 *  space of p2. The window holds both profiles. */
const rows = (over: Partial<Parameters<typeof sessionProbeRows>[0]> = {}): AgentProbe[] => sessionProbeRows({
  agentProbe: [work, codex], sessionClaude: {}, claudeDirs: { p1: { anyNamed: true }, p2: { anyNamed: true } }, profiles: [{ id: "p1" }, { id: "p2" }], session: null, activeProfileId: "p1",
  spaces: [{ id: "s1", profileId: "p1" }, { id: "s9", profileId: "p2" }], ...over,
});
/** A session of space s1 that holds no conversation yet. */
const fresh: ProbedSession = { id: "se1", spaceId: "s1", providerSessionId: null };
/** A session of space s1 that holds a conversation. */
const begun: ProbedSession = { id: "se2", spaceId: "s1", providerSessionId: "conversation-1" };
/** A session of another profile's space, as a peek or the quick chat can show. */
const elsewhere: ProbedSession = { id: "se9", spaceId: "s9", providerSessionId: null };

/** A booted window on p1 that holds space s1 and its two sessions, with the probe and both
 *  profiles' folders landed, and the fake it was booted over, for a test that changes what the
 *  server answers afterwards. p1 names the work folder unless `claudeDirs` says otherwise. */
async function booted(claudeDirs: Record<string, ClaudeDir> = { p1: claudeFolder("/Users/u/.claude-work") }): Promise<{ api: FakeApi; store: StoreApi<AppState> }> {
  const api = fakeApi({
    profiles: [profile("p1", "Work"), profile("p2", "Personal")],
    spaces: [space("s1", "p1", "Versed"), space("s9", "p2", "Thesis")],
    items: { s1: [item("i1", "s1", { kind: "session", refId: "se1" }), item("i2", "s1", { kind: "session", refId: "se2" })], s9: [] },
    sessions: [session("se1", "s1"), session("se2", "s1", { providerSessionId: "conversation-1" })],
    agentProbe: [work, codex], claudeDirs,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().probeAgents();
  await vi.waitFor(() => expect(Object.keys(store.getState().claudeDirs).sort()).toEqual(["p1", "p2"]));
  return { api, store };
}

/** That window alone, which is all most tests here read. */
async function onWork(claudeDirs?: Record<string, ClaudeDir>): Promise<StoreApi<AppState>> {
  return (await booted(claudeDirs)).store;
}

/** The hook mounted over `store` for one session, which a test can then hand another row of. */
function handed(store: StoreApi<AppState>, at: ProbedSession | null | undefined) {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(StoreContext.Provider, { value: store }, children);
  return renderHook(({ s }: { s: ProbedSession | null | undefined }) => useSessionProbe(s), { wrapper, initialProps: { s: at } });
}

describe("a Claude row with its sign-in not yet known", () => {
  it("keeps what is true of every folder: that the CLI is installed, and its version", () => {
    expect(unknownClaude(work)).toMatchObject({ kind: "claude", available: true, version: "2.1.296" });
  });

  it("names no account, so no chip is drawn for a folder nobody has heard from", () => {
    expect(unknownClaude(work)).not.toHaveProperty("account");
  });

  it("names no folder", () => {
    expect(unknownClaude(work)).not.toHaveProperty("home");
  });

  it("lists no models, which are the ones another account is offered", () => {
    expect(unknownClaude(work)).not.toHaveProperty("models");
  });

  it("reads as not yet known, with no reason given, where the row it came from said signed out", () => {
    const signedOut: AgentProbe = { ...work, loggedIn: false, reason: "not signed in — run `claude auth login`" };
    expect(unknownClaude(signedOut)).toMatchObject({ loggedIn: null, reason: null });
  });

  it("leaves the row it was given as it was", () => {
    const given: AgentProbe = { ...work };
    unknownClaude(given);
    expect(given).toEqual(work);
  });

  it("says nothing of a folder being missing, which is true of the folder the row came from and of no other", () => {
    expect(unknownClaude(gone)).not.toHaveProperty("homeMissing");
  });
});

describe("the probe rows one session reads", () => {
  it("are the list as it is where no session is behind the prompter", () => {
    const agentProbe = [work, codex];
    expect(rows({ agentProbe, session: null })).toBe(agentProbe);
    expect(rows({ agentProbe, session: undefined })).toBe(agentProbe);
  });

  it("put the session's own Claude row where Claude's was, and leave the other agents' rows alone", () => {
    expect(rows({ session: begun, sessionClaude: { se2: personal } })).toEqual([personal, codex]);
  });

  it("add the session's own row to a list that has no Claude row yet", () => {
    expect(rows({ agentProbe: [codex], session: begun, sessionClaude: { se2: personal } })).toEqual([codex, personal]);
  });

  it("take another session's own row as nothing about this one", () => {
    expect(claudeOf(rows({ session: begun, sessionClaude: { se9: personal } }))).toEqual(unknownClaude(work));
  });

  it("are the active profile's list for a session that holds no conversation yet in one of its spaces", () => {
    const agentProbe = [work, codex];
    expect(rows({ agentProbe, session: fresh })).toBe(agentProbe);
  });

  it("prefer the session's own row to the profile's even before it holds a conversation", () => {
    expect(claudeOf(rows({ session: fresh, sessionClaude: { se1: personal } }))).toBe(personal);
  });

  it("do not show the profile's account to a session that holds a conversation", () => {
    expect(claudeOf(rows({ session: begun }))).toEqual(unknownClaude(work));
  });

  it("do not show the profile's account to a session of another profile's space", () => {
    expect(claudeOf(rows({ session: elsewhere }))).toEqual(unknownClaude(work));
  });

  it("do not show it to a session whose space the window does not hold", () => {
    expect(claudeOf(rows({ session: { id: "se7", spaceId: "s7", providerSessionId: null } }))).toEqual(unknownClaude(work));
  });

  it("do not show it to anyone before a profile is the window's", () => {
    expect(claudeOf(rows({ session: fresh, activeProfileId: null }))).toEqual(unknownClaude(work));
  });

  it("are the list as it is for every session while the server says only the default folder is in use", () => {
    const agentProbe = [personal, codex];
    const unheld: ProbedSession = { id: "se7", spaceId: "s7", providerSessionId: "conversation-7" };
    for (const at of [begun, elsewhere, unheld]) expect(rows({ agentProbe, claudeDirs: noneNamed, session: at })).toBe(agentProbe);
    expect(rows({ agentProbe, claudeDirs: noneNamed, session: begun, activeProfileId: null })).toBe(agentProbe);
  });

  it("set the session's own row aside while only the default folder is in use, since the list is about the same folder", () => {
    const agentProbe = [personal, codex];
    const older: AgentProbe = { ...personal, loggedIn: false, reason: "not signed in" };
    expect(rows({ agentProbe, claudeDirs: noneNamed, session: begun, sessionClaude: { se2: older } })).toBe(agentProbe);
  });

  it("still put first an own row that names a folder, which says the server's word is out of date", () => {
    expect(claudeOf(rows({ agentProbe: [personal, codex], claudeDirs: noneNamed, session: begun, sessionClaude: { se2: work } }))).toBe(work);
  });

  it("do not take the list as true of a conversation before any profile's folder has been answered", () => {
    expect(claudeOf(rows({ claudeDirs: {}, session: begun }))).toEqual(unknownClaude(work));
  });

  it("do not take it as true while one answer says a folder is in use, whichever profile's answer it is", () => {
    expect(claudeOf(rows({ claudeDirs: { p1: { anyNamed: false }, p2: { anyNamed: true } }, session: begun }))).toEqual(unknownClaude(work));
    expect(claudeOf(rows({ claudeDirs: { p1: { anyNamed: true }, p2: { anyNamed: false } }, session: elsewhere }))).toEqual(unknownClaude(work));
  });

  it("do not count the answer held for a profile the window no longer holds, which says what was true before that profile was deleted", () => {
    const agentProbe = [personal, codex];
    expect(rows({ agentProbe, claudeDirs: { p1: { anyNamed: false }, p2: { anyNamed: true } }, profiles: [{ id: "p1" }], session: begun })).toBe(agentProbe);
  });

  it("do not take the list as true of a conversation while the only answers held are for profiles the window no longer holds", () => {
    expect(claudeOf(rows({ claudeDirs: { p2: { anyNamed: false } }, profiles: [{ id: "p1" }], session: begun }))).toEqual(unknownClaude(work));
  });

  it("leave the other agents' rows alone when Claude's sign-in is taken off", () => {
    expect(rows({ session: begun })[1]).toBe(codex);
  });

  it("do not put the card for the profile's missing folder over a session that runs under another folder", () => {
    expect(agentAvailability("claude", rows({ agentProbe: [gone, codex], session: elsewhere })).state).toBe("ready");
  });

  it("are the list as it is when it holds no Claude row to take the sign-in off", () => {
    const agentProbe = [codex];
    expect(rows({ agentProbe, session: begun })).toBe(agentProbe);
  });
});

describe("the probe rows a pane is handed", () => {
  it("are the list as it is for a session that holds no conversation yet in the active profile", async () => {
    const store = await onWork();
    expect(handed(store, store.getState().sessions.se1).result.current).toBe(store.getState().agentProbe);
  });

  it("are the list as it is where no session is behind the prompter", async () => {
    const store = await onWork();
    expect(handed(store, null).result.current).toBe(store.getState().agentProbe);
  });

  it("say nothing of Claude's sign-in for a session of another profile, which the window can still show", async () => {
    const store = await onWork();
    expect(claudeOf(handed(store, session("se9", "s9")).result.current)).toEqual(unknownClaude(work));
  });

  it("carry the session's own Claude row from the moment the store holds one", async () => {
    const store = await onWork();
    const { result } = handed(store, store.getState().sessions.se2);
    act(() => { store.setState({ sessionClaude: { se2: personal } }); });
    expect(result.current).toEqual([personal, codex]);
  });

  it("follow the list when the active profile's probe lands again", async () => {
    const store = await onWork();
    const { result } = handed(store, store.getState().sessions.se2);
    const updated: AgentProbe = { ...work, version: "2.2.0" };
    act(() => { store.setState({ agentProbe: [updated, codex] }); });
    expect(claudeOf(result.current)).toEqual(unknownClaude(updated));
  });

  it("lose the profile's account the moment the session holds a conversation", async () => {
    const store = await onWork();
    const { result, rerender } = handed(store, store.getState().sessions.se1);
    rerender({ s: { ...store.getState().sessions.se1!, providerSessionId: "conversation-2" } });
    expect(claudeOf(result.current)).toEqual(unknownClaude(work));
  });

  it("lose the profile's account when the window moves to a profile the session is not of", async () => {
    const store = await onWork();
    const { result } = handed(store, store.getState().sessions.se1);
    act(() => { store.setState({ activeProfileId: "p2" }); });
    expect(claudeOf(result.current)).toEqual(unknownClaude(work));
  });

  it("are the list as it is for a conversation, and for another profile's session, where no folder is named", async () => {
    const store = await onWork({});
    expect(handed(store, store.getState().sessions.se2).result.current).toBe(store.getState().agentProbe);
    expect(handed(store, session("se9", "s9", { providerSessionId: "conversation-9" })).result.current).toBe(store.getState().agentProbe);
  });

  it("stay the list itself when the session's own row lands where no folder is named", async () => {
    const store = await onWork({});
    const { result } = handed(store, store.getState().sessions.se2);
    act(() => { store.setState({ sessionClaude: { se2: { ...work, home: null } } }); });
    expect(result.current).toBe(store.getState().agentProbe);
  });

  it("lose the list's account for a conversation the moment any profile is named a folder", async () => {
    const store = await onWork({});
    const { result } = handed(store, store.getState().sessions.se2);
    act(() => { store.getState().applyClaudeDir({ profileId: "p2", ...claudeFolder("/Users/u/.claude-personal") }); });
    expect(store.getState().agentProbe).toEqual([work, codex]);
    expect(claudeOf(result.current)).toEqual(unknownClaude(work));
  });

  it("are the list as it is again for a conversation once the last folder in use is given back", async () => {
    const store = await onWork({ p1: claudeFolder("/Users/u/.claude-work"), p2: claudeFolder(null, { anyNamed: true }) });
    const { result } = handed(store, store.getState().sessions.se2);
    expect(claudeOf(result.current)).toEqual(unknownClaude(work));
    await act(async () => { await store.getState().setClaudeDir("p1", null); });
    expect(result.current).toBe(store.getState().agentProbe);
  });

  it("are the list as it is again for a conversation once the profile that named the last folder in use is deleted, though no event says a folder was given back", async () => {
    const { api, store } = await booted({ p1: claudeFolder(null, { anyNamed: true }), p2: claudeFolder("/Users/u/.claude-personal") });
    const { result } = handed(store, store.getState().sessions.se2);
    expect(claudeOf(result.current)).toEqual(unknownClaude(work));
    api.data.profiles = [profile("p1", "Work")];
    api.data.claudeDirs.p1 = claudeFolder(null);
    await act(async () => { await store.getState().refreshProfiles(); });
    expect(result.current).toBe(store.getState().agentProbe);
  });

  it("are the same list when the session's row is replaced by one that reads the same", async () => {
    const store = await onWork();
    const { result, rerender } = handed(store, store.getState().sessions.se2);
    const first = result.current;
    act(() => { store.getState().applySessionStatus("se2", "running"); });
    rerender({ s: store.getState().sessions.se2 });
    expect(result.current).toBe(first);
  });

  it("are the same list when another session's own row lands", async () => {
    const store = await onWork();
    const { result } = handed(store, store.getState().sessions.se2);
    const first = result.current;
    act(() => { store.setState({ sessionClaude: { se9: personal } }); });
    expect(result.current).toBe(first);
  });

  it("are the same list when the spaces are read again and say the same", async () => {
    const store = await onWork();
    const { result } = handed(store, store.getState().sessions.se2);
    const first = result.current;
    act(() => { store.setState({ spaces: store.getState().spaces.map((sp) => ({ ...sp })) }); });
    expect(result.current).toBe(first);
  });
});
