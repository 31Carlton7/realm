import { describe, expect, it } from "vitest";
import type { AgentSignIn } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi } from "./store.test-fakes";

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
