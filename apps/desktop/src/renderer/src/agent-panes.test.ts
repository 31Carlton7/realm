import { describe, expect, it, vi } from "vitest";
import { findSidePane } from "@realm/contracts";
import { AGENT_PANE_EVENTS, subscribeAgentPanes, subscribeSpaceLists } from "./App";
import { createAppStore } from "./state/store";
import { fakeApi, item, session, space } from "./state/store.test-fakes";

/** The lead session's pane open and focused, and every agent-open broadcast captured by name. */
async function lead() {
  const api = fakeApi({ items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" })] }, sessions: [session("lead", "s1")] });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  const handlers = new Map<string, (p: unknown) => void>();
  const off = subscribeAgentPanes(store, (event, fn) => {
    handlers.set(event, fn as (p: unknown) => void);
    return () => { handlers.delete(event); };
  });
  return { api, store, handlers, off };
}

describe("panes an agent opens", () => {
  it("puts a terminal the agent opened in the side pane of the session that asked", async () => {
    // THE MUTANT: leave `terminal.agentOpened` unheard. The server says the shell exists and the app
    // only learns of it through `items.changed`, which makes a sidebar row and no pane.
    const { api, store, handlers } = await lead();
    api.data.items.s1!.push(item("i-term", "s1", { kind: "terminal", refId: "t9", title: "Terminal" }));
    handlers.get("terminal.agentOpened")!({ spaceId: "s1", terminalId: "t9", itemId: "i-term", openedBy: "lead" });
    await vi.waitFor(() => expect(findSidePane(store.getState().layout!, "i-lead")).toMatchObject({ itemId: "i-term", tabs: ["i-term"] }));
  });

  it("hears every kind of agent open, and lets go of all of them", async () => {
    const { handlers, off } = await lead();
    expect([...handlers.keys()].sort()).toEqual([...AGENT_PANE_EVENTS].sort());
    off();
    expect(handlers.size).toBe(0);
  });
});

describe("a space's lists changing", () => {
  /** Two spaces of the window's profile and one of another's, every broadcast captured by name. */
  async function listening() {
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s9", "p2", "Elsewhere")],
      items: { s1: [item("i1", "s1")], s2: [], s9: [] },
    });
    const store = createAppStore(api);
    await store.getState().boot();
    const handlers = new Map<string, (p: unknown) => void>();
    const off = subscribeSpaceLists(store, (event, fn) => {
      handlers.set(event, fn as (p: unknown) => void);
      return () => { handlers.delete(event); };
    });
    return { api, store, handlers, off };
  }

  it("is heard for every space of the profile, not just the current one", async () => {
    // THE MUTANT: the old `spaceId === activeSpaceId` gate. An agent's new session in a space you are
    // not looking at would never reach its list, and the sidebar would miss it until a relaunch.
    const { api, store, handlers } = await listening();
    expect(store.getState().activeSpaceId).toBe("s1");
    api.data.items.s2!.push(item("i-new", "s2", { kind: "session", refId: "new" }));
    api.data.sessions.push(session("new", "s2"));
    handlers.get("items.changed")!({ spaceId: "s2" });
    await vi.waitFor(() => expect(store.getState().items.map((i) => i.id)).toEqual(["i1", "i-new"]));
    await vi.waitFor(() => expect(store.getState().sessions["new"]).toBeDefined());
  });

  it("reads checkouts and scripts of a space that is not current too", async () => {
    const { api, store, handlers } = await listening();
    api.data.environments.s2 = [{ id: "env2", spaceId: "s2", path: "/w/two", branch: "main", kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 }];
    handlers.get("environments.changed")!({ spaceId: "s2" });
    await vi.waitFor(() => expect(store.getState().environments["env2"]).toBeDefined());
    api.calls.length = 0;
    handlers.get("scripts.changed")!({ spaceId: "s2" });
    await vi.waitFor(() => expect(api.calls).toContain("listScripts:s2"));
  });

  it("ignores another profile's spaces — this window does not hold them", async () => {
    const { api, handlers, off } = await listening();
    api.calls.length = 0;
    handlers.get("items.changed")!({ spaceId: "s9" });
    handlers.get("environments.changed")!({ spaceId: "s9" });
    handlers.get("scripts.changed")!({ spaceId: "s9" });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls).toEqual([]);
    off();
    expect(handlers.size).toBe(0);
  });
});
